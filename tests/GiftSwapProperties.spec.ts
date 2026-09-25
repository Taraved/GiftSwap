import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, Transaction, beginCell, toNano } from '@ton/core';
import {
    GiftSwap,
    Constants,
    Opcodes,
    SwapState,
    excessesBody,
    ownershipAssignedBody,
    reportStaticDataBody,
} from '../wrappers/GiftSwap';
import { MockNftItem } from '../wrappers/MockNftItem';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// Property-based проверка: случайные, но воспроизводимые (по номеру сценария) последовательности действий
// всех участников. После КАЖДОГО действия проверяются инварианты, которые должны выполняться всегда,
// в каком бы порядке и с какими суммами ни приходили сообщения. Упавший сценарий печатает журнал действий.

// Простой детерминированный генератор случайных чисел (mulberry32): один и тот же номер даёт те же действия.
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SCENARIOS = 50;
const STEPS = 40;

const PRICE = toNano('1');
const FEES = Constants.nftTransferMin + Constants.gasReserve;
// Сколько покупатель может потерять на одной неудачной попытке Buy: запас на газ, TON, оставшиеся у NFT
// при Refund, и газ на отказ (с запасом).
const MAX_LOSS_PER_BUY = FEES + toNano('0.01');

describe('GiftSwap properties (random scenarios)', () => {
    let swapCode: Cell;
    let nftCode: Cell;

    beforeAll(async () => {
        swapCode = await compile('GiftSwap');
        nftCode = await compile('MockNftItem');
    });

    it.each(Array.from({ length: SCENARIOS }, (_, i) => i + 1))('scenario #%i keeps all invariants', async (seed) => {
        const rnd = mulberry32(seed);
        const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];

        const blockchain = await Blockchain.create();
        let now = 1_800_000_000;
        blockchain.now = now;

        const deployer = await blockchain.treasury('deployer');
        const seller = await blockchain.treasury('seller');
        const buyerA = await blockchain.treasury('buyerA');
        const buyerB = await blockchain.treasury('buyerB');
        const attacker = await blockchain.treasury('attacker');
        const buyers = [buyerA, buyerB];
        const everyone = [seller, buyerA, buyerB, attacker];
        const name = (a: Address) =>
            [
                ['seller', seller],
                ['buyerA', buyerA],
                ['buyerB', buyerB],
                ['attacker', attacker],
            ].find(([, t]) => (t as SandboxContract<TreasuryContract>).address.equals(a))?.[0] ?? a.toString();

        const nft = blockchain.openContract(MockNftItem.createFromConfig({ owner: seller.address }, nftCode));
        await nft.sendDeploy(deployer.getSender(), toNano('0.05'));
        const giftSwap = blockchain.openContract(
            GiftSwap.createFromConfig({ seller: seller.address, nftAddress: nft.address, price: PRICE }, swapCode),
        );
        await giftSwap.sendDeploy(deployer.getSender(), toNano('0.05'));

        // ---- учёт денег и событий ----
        const paidIn = new Map<string, bigint>(); // сколько покупатель отправил контракту
        const received = new Map<string, bigint>(); // сколько контракт отправил покупателю (включая bounce)
        const allowance = new Map<string, bigint>(); // сколько покупатель может потерять, не считая цены
        for (const b of buyers) {
            paidIn.set(b.address.toString(), 0n);
            received.set(b.address.toString(), 0n);
            allowance.set(b.address.toString(), 0n);
        }
        let pricePayments = 0; // выплаты цены продавцу
        let saleBuyer: Address | null = null; // покупатель состоявшейся сделки
        let pendingBuyer: Address | null = null; // кому контракт последним просил перевести NFT при покупке
        const log: string[] = [];

        const account = (tx: Transaction) => {
            const info = tx.inMessage?.info;
            if (info?.type !== 'internal') return;
            const value = info.value.coins;
            for (const b of buyers) {
                const key = b.address.toString();
                if (info.src.equals(b.address) && info.dest.equals(giftSwap.address)) {
                    paidIn.set(key, paidIn.get(key)! + value);
                }
                if (info.src.equals(giftSwap.address) && info.dest.equals(b.address)) {
                    received.set(key, received.get(key)! + value);
                }
            }
            // Перевод NFT при покупке: от контракта к NFT, с bounce, новый владелец не продавец.
            // (Перевод при Cancel идёт продавцу, а возврат ненужного NFT отправляется без bounce.)
            if (info.src.equals(giftSwap.address) && info.dest.equals(nft.address) && info.bounce) {
                const body = tx.inMessage!.body.beginParse();
                if (body.remainingBits >= 32 && body.loadUint(32) === Opcodes.nftTransfer) {
                    body.loadUint(64);
                    const newOwner = body.loadAddress();
                    if (!newOwner.equals(seller.address)) pendingBuyer = newOwner;
                }
            }
            if (
                info.src.equals(giftSwap.address) &&
                info.dest.equals(seller.address) &&
                !info.bounced &&
                value === PRICE
            ) {
                pricePayments++;
                saleBuyer = pendingBuyer;
            }
        };
        const run = async (label: string, action: () => Promise<SendMessageResult | void>) => {
            log.push(label);
            const result = await action();
            if (result) result.transactions.forEach(account);
        };

        // ---- действия ----
        const actions: Array<() => Promise<void>> = [
            // Продавец переводит NFT контракту с разным forward_amount (0 и пыль тоже бывают).
            async () => {
                const forward = pick([0n, 1n, toNano('0.001'), toNano('0.01'), toNano('0.05')]);
                await run(`seller deposits NFT, forward ${forward}`, () =>
                    nft.sendTransfer(seller.getSender(), toNano('0.1'), {
                        newOwner: giftSwap.address,
                        responseDestination: seller.address,
                        forwardAmount: forward,
                    }),
                );
            },
            // Покупка с разными суммами: меньше цены, на 1 нанотон меньше минимума, минимум, с запасом.
            async () => {
                const b = pick(buyers);
                const value = pick([PRICE - toNano('0.1'), PRICE + FEES - 1n, PRICE + FEES, PRICE + FEES + toNano('0.3')]);
                allowance.set(b.address.toString(), allowance.get(b.address.toString())! + MAX_LOSS_PER_BUY);
                await run(`${name(b.address)} buys with ${value}`, () => giftSwap.sendBuy(b.getSender(), value));
            },
            async () => {
                const who = pick([seller, attacker]);
                const value = pick([toNano('0.05'), FEES, toNano('0.1')]);
                await run(`${name(who.address)} cancels with ${value}`, () => giftSwap.sendCancel(who.getSender(), value));
            },
            async () => {
                const who = pick([seller, attacker]);
                await run(`${name(who.address)} withdraws`, () => giftSwap.sendWithdraw(who.getSender(), toNano('0.05')));
            },
            async () => {
                const who = pick([buyerA, buyerB, attacker]);
                const value = pick([Constants.settleMin - 1n, Constants.settleMin, toNano('0.05')]);
                if (buyers.includes(who)) {
                    // Settle оплачивает сам отправитель: это его расход, а не потеря на сделке.
                    const key = who.address.toString();
                    allowance.set(key, allowance.get(key)! + value);
                }
                await run(`${name(who.address)} settles with ${value}`, () => giftSwap.sendSettle(who.getSender(), value));
            },
            async () => {
                const who = pick(everyone);
                if (buyers.includes(who)) {
                    // Отклонённый Refund стоит отправителю газа: это его расход, а не потеря на сделке.
                    const key = who.address.toString();
                    allowance.set(key, allowance.get(key)! + toNano('0.05'));
                }
                await run(`${name(who.address)} asks refund`, () => giftSwap.sendRefund(who.getSender(), toNano('0.05')));
            },
            async () => {
                now += pick([60, 3600, 24 * 3600, 31 * 24 * 3600]);
                blockchain.now = now;
                log.push(`time -> ${now}`);
            },
            async () => {
                const reject = rnd() < 0.5;
                await run(`NFT rejects transfers: ${reject}`, () =>
                    nft.sendSetReject(deployer.getSender(), toNano('0.05'), reject),
                );
            },
            async () => {
                const skip = rnd() < 0.5;
                await run(`NFT skips excesses: ${skip}`, () =>
                    nft.sendSetSkipExcesses(deployer.getSender(), toNano('0.05'), skip),
                );
            },
            // Подделки от злоумышленника: уведомление, excesses и ответ на запрос с ТЕКУЩИМ query_id.
            async () => {
                const { queryId } = await giftSwap.getSwapInfo();
                const body = pick([
                    ownershipAssignedBody(pick(everyone).address),
                    excessesBody(queryId),
                    reportStaticDataBody(queryId),
                    beginCell().storeUint(0x12345678, 32).endCell(),
                ]);
                const value = pick([toNano('0.001'), toNano('0.05')]);
                await run(`attacker sends a fake message`, () =>
                    attacker.send({ to: giftSwap.address, value, bounce: false, body }),
                );
            },
            // Покупатель, получивший NFT, по ошибке отправляет его обратно контракту.
            async () => {
                const owner = await nft.getOwner();
                const b = buyers.find((x) => x.address.equals(owner));
                if (!b) return;
                const forward = pick([toNano('0.01'), toNano('0.05')]);
                await run(`${name(b.address)} sends the NFT back, forward ${forward}`, () =>
                    nft.sendTransfer(b.getSender(), toNano('0.1'), {
                        newOwner: giftSwap.address,
                        responseDestination: b.address,
                        forwardAmount: forward,
                    }),
                );
            },
            async () => {
                await run('top-up', () => deployer.send({ to: giftSwap.address, value: toNano('0.05') }));
            },
        ];

        // ---- инварианты ----
        const check = async () => {
            const info = await giftSwap.getSwapInfo();
            const owner = await nft.getOwner();
            const contract = await blockchain.getContract(giftSwap.address);
            const is = (a: Address | null) => a !== null && owner.equals(a);

            // 1. Продавцу платят не больше одного раза, и только когда NFT у покупателя этой сделки.
            expect(pricePayments).toBeLessThanOrEqual(1);
            if (pricePayments === 1) {
                expect(info.state).toBe(SwapState.Sold);
                expect(is(saleBuyer)).toBe(true);
            }
            // 2. Состояние сделки согласовано с тем, у кого NFT.
            if (info.state === SwapState.ForSale) expect(is(giftSwap.address)).toBe(true);
            if (info.state === SwapState.Transferring) expect(is(giftSwap.address) || is(info.buyer)).toBe(true);
            if (info.state === SwapState.WaitingNft || info.state === SwapState.Cancelled) {
                expect(is(seller.address) || is(giftSwap.address)).toBe(true);
            }
            if (info.state === SwapState.Sold) expect(pricePayments).toBe(1);
            // 3. Злоумышленник никогда не получает NFT.
            expect(is(attacker.address)).toBe(false);
            // 4. Покупатель не теряет больше цены своей сделки плюс допустимых расходов.
            // Во время покупки (Transferring) деньги текущего покупателя удержаны контрактом, а не потеряны.
            for (const b of buyers) {
                const key = b.address.toString();
                const loss = paidIn.get(key)! - received.get(key)!;
                const price = saleBuyer !== null && b.address.equals(saleBuyer) ? PRICE : 0n;
                const held =
                    info.state === SwapState.Transferring && info.buyer !== null && b.address.equals(info.buyer)
                        ? info.paid
                        : 0n;
                expect(loss).toBeLessThanOrEqual(price + held + allowance.get(key)!);
                // 5. Покупатель состоявшейся сделки заплатил не меньше цены (продавцу не платят из чужих денег).
                if (price > 0n) expect(loss).toBeGreaterThanOrEqual(PRICE);
            }
            // 6. Во время покупки деньги покупателя лежат на контракте (кроме того, что ушло NFT на перевод).
            if (info.state === SwapState.Transferring) {
                expect(contract.balance).toBeGreaterThanOrEqual(info.paid - Constants.nftTransferMin);
            }
            // 7. Контракт жив: не заморожен и не опустошён.
            expect(contract.accountState?.type).toBe('active');
            expect(contract.balance).toBeGreaterThanOrEqual(toNano('0.01'));
        };

        // Живучесть: из любого состояния сделку можно довести до конца, если NFT ведёт себя нормально.
        // Зависшая покупка закрывается через Settle, открытая продажа — обычной покупкой.
        const finish = async () => {
            log.push('--- finish: the NFT behaves normally again');
            await nft.sendSetReject(deployer.getSender(), toNano('0.05'), false);
            await nft.sendSetSkipExcesses(deployer.getSender(), toNano('0.05'), false);
            const key = buyerA.address.toString();
            if ((await giftSwap.getSwapInfo()).state === SwapState.Transferring) {
                allowance.set(key, allowance.get(key)! + Constants.settleMin);
                await run('buyerA settles', () => giftSwap.sendSettle(buyerA.getSender(), Constants.settleMin));
                expect((await giftSwap.getSwapInfo()).state).not.toBe(SwapState.Transferring);
            }
            if ((await giftSwap.getSwapInfo()).state === SwapState.ForSale) {
                allowance.set(key, allowance.get(key)! + MAX_LOSS_PER_BUY);
                await run('buyerA buys', () => giftSwap.sendBuy(buyerA.getSender(), PRICE + FEES + toNano('0.3')));
                expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
                expect((await nft.getOwner()).equals(buyerA.address)).toBe(true);
            }
            await check();
        };

        try {
            for (let step = 0; step < STEPS; step++) {
                await pick(actions)();
                await check();
            }
            await finish();
        } catch (e) {
            console.log(`scenario #${seed} failed after:\n  ${log.join('\n  ')}`);
            throw e;
        }
    }, 120_000);
});
