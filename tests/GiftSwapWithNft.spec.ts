import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, Transaction, toNano } from '@ton/core';
import { GiftSwap, Constants, Errors, SwapState } from '../wrappers/GiftSwap';
import { MockNftItem, NftErrors, NftOpcodes } from '../wrappers/MockNftItem';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// Здесь вместо кошелька-заглушки используется MockNftItem (TEP-62),
// поэтому проверяется весь путь: transfer -> ownership_assigned -> Buy -> transfer -> excesses.
describe('GiftSwap with a TEP-62 NFT', () => {
    let swapCode: Cell;
    let nftCode: Cell;

    beforeAll(async () => {
        swapCode = await compile('GiftSwap');
        nftCode = await compile('MockNftItem');
    });

    const PRICE = toNano('1');
    const GAS_RESERVE = Constants.gasReserve;
    const FEES = Constants.nftTransferMin + Constants.gasReserve; // NFT_TRANSFER_MIN + GAS_RESERVE
    const ENOUGH = PRICE + FEES + toNano('0.1');

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let nft: SandboxContract<MockNftItem>;
    let giftSwap: SandboxContract<GiftSwap>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        seller = await blockchain.treasury('seller');
        buyer = await blockchain.treasury('buyer');
        attacker = await blockchain.treasury('attacker');

        // NFT принадлежит продавцу
        nft = blockchain.openContract(MockNftItem.createFromConfig({ owner: seller.address }, nftCode));
        await nft.sendDeploy(deployer.getSender(), toNano('0.05'));
        expect((await nft.getOwner()).equals(seller.address)).toBe(true);

        giftSwap = blockchain.openContract(
            GiftSwap.createFromConfig(
                { seller: seller.address, nftAddress: nft.address, price: PRICE },
                swapCode,
            ),
        );
        await giftSwap.sendDeploy(deployer.getSender(), toNano('0.05'));
    });

    // Продавец переводит NFT на GiftSwap. forwardAmount > 0 обязателен, иначе уведомления не будет.
    async function depositNft(forwardAmount = toNano('0.05')) {
        return nft.sendTransfer(seller.getSender(), toNano('0.1'), {
            newOwner: giftSwap.address,
            responseDestination: seller.address,
            forwardAmount,
        });
    }

    // ---------- Депозит ----------

    it('deposit: real transfer makes GiftSwap ForSale and owner of the NFT', async () => {
        const result = await depositNft();

        expect(result.transactions).toHaveTransaction({
            from: seller.address,
            to: nft.address,
            success: true,
        });
        // настоящее уведомление ownership_assigned дошло до GiftSwap и принято
        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            op: NftOpcodes.ownershipAssigned,
            success: true,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
    });

    it('deposit with forward_amount = 0: NO notification, NFT gets stuck in WaitingNft', async () => {
        // Известная ловушка. Выход: Cancel в WaitingNft (см. тест «cancel in WaitingNft rescues…» ниже).
        const result = await depositNft(0n);

        expect(result.transactions).not.toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
    });

    // ---------- Атаки ----------

    it('attack: a different real NFT is rejected by GiftSwap', async () => {
        const otherNft = blockchain.openContract(
            MockNftItem.createFromConfig({ owner: attacker.address }, nftCode),
        );
        await otherNft.sendDeploy(deployer.getSender(), toNano('0.05'));

        const result = await otherNft.sendTransfer(attacker.getSender(), toNano('0.1'), {
            newOwner: giftSwap.address,
            responseDestination: attacker.address,
            forwardAmount: toNano('0.05'),
        });

        expect(result.transactions).toHaveTransaction({
            from: otherNft.address,
            to: giftSwap.address,
            op: NftOpcodes.ownershipAssigned,
            success: false,
            exitCode: Errors.notExpectedNft,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('attack: only the real owner can move the NFT', async () => {
        const result = await nft.sendTransfer(attacker.getSender(), toNano('0.1'), {
            newOwner: attacker.address,
            responseDestination: attacker.address,
            forwardAmount: 0n,
        });

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: nft.address,
            success: false,
            exitCode: NftErrors.notOwner,
        });
        expect((await nft.getOwner()).equals(seller.address)).toBe(true);
    });

    // ---------- Покупка ----------

    it('buy: NFT goes to the buyer, seller is paid, excess returns to the buyer', async () => {
        await depositNft();

        const result = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: nft.address,
            op: NftOpcodes.transfer,
            success: true,
        });
        // NFT подтвердил перевод: excesses пришёл на GiftSwap
        const confirmation = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(nft.address) &&
                tx.inMessage.info.dest.equals(giftSwap.address),
        )!;
        expect(confirmation).toBeDefined();
        expect(confirmation.inMessage!.body.beginParse().loadUint(32)).toBe(NftOpcodes.excesses);

        // и только ПОСЛЕ подтверждения продавцу ушла цена
        const payout = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(giftSwap.address) &&
                tx.inMessage.info.dest.equals(seller.address),
        )!;
        expect(payout).toBeDefined();
        expect(payout.lt).toBeGreaterThan(confirmation.lt);
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
            value: PRICE,
        });
        // возврат покупателю = оплачено - цена - (NFT_TRANSFER_MIN + GAS_RESERVE) + то, что NFT реально вернул
        const returned = (confirmation.inMessage!.info as any).value.coins as bigint;
        const creditedBack = returned < Constants.nftTransferMin ? returned : Constants.nftTransferMin;
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - PRICE - FEES + creditedBack,
        });

        expect((await nft.getOwner()).equals(buyer.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('failed NFT transfer: bounce returns the money to the buyer and the sale stays open', async () => {
        await depositNft();
        // NFT начинает отказываться от переводов (после успешного депозита)
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);

        const result = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        // NFT отверг перевод
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: nft.address,
            success: false,
            exitCode: NftErrors.transfersRejected,
        });
        // покупатель получил деньги назад (оплачено - GAS_RESERVE)
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - GAS_RESERVE,
        });
        // продавцу не заплатили, NFT не сдвинулся
        expect(result.transactions).not.toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);

        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.ForSale);
        expect(info.buyer).toBeNull();
        expect(info.paid).toBe(0n);
    });

    it('after a failed transfer the purchase can be retried and succeeds', async () => {
        await depositNft();
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), false);

        const retry = await giftSwap.sendBuy(attacker.getSender(), ENOUGH);

        expect(retry.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
            value: PRICE,
        });
        expect((await nft.getOwner()).equals(attacker.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('buy with the minimal valid amount: the real NFT accepts our attached TON', async () => {
        await depositNft();

        const result = await giftSwap.sendBuy(buyer.getSender(), PRICE + FEES);

        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: nft.address,
            op: NftOpcodes.transfer,
            success: true,
        });
        expect((await nft.getOwner()).equals(buyer.address)).toBe(true);
    });

    it('attack: repeated purchase does not move the NFT again', async () => {
        await depositNft();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const second = await giftSwap.sendBuy(attacker.getSender(), ENOUGH);

        expect(second.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(second.transactions).not.toHaveTransaction({ from: giftSwap.address, to: nft.address });
        expect((await nft.getOwner()).equals(buyer.address)).toBe(true);
    });

    it('attack: wrong amount does not move the NFT or pay the seller', async () => {
        await depositNft();

        const result = await giftSwap.sendBuy(buyer.getSender(), PRICE);

        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongAmount,
        });
        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: nft.address });
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
    });

    // ---------- Отмена ----------

    it('cancel: the NFT returns to the seller', async () => {
        await depositNft();

        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: nft.address,
            op: NftOpcodes.transfer,
            success: true,
        });
        expect((await nft.getOwner()).equals(seller.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Cancelled);
    });

    // ---------- Шаг 3: спасение застрявшего NFT, сбой Cancel, Withdraw ----------

    const KEEP = Constants.withdrawKeep;
    const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;

    it('cancel in WaitingNft rescues an NFT sent without forward_amount; the seller can then re-deposit', async () => {
        await depositNft(0n); // ошибка продавца: уведомления не будет
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);

        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: nft.address,
            op: NftOpcodes.transfer,
            success: true,
        });
        expect((await nft.getOwner()).equals(seller.address)).toBe(true);
        // сделка не начиналась, поэтому состояние не меняется: можно исправиться
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);

        await depositNft();
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
    });

    it('cancel in WaitingNft by a stranger is rejected and the NFT stays', async () => {
        await depositNft(0n);

        const result = await giftSwap.sendCancel(attacker.getSender(), toNano('0.1'));

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notSeller,
        });
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
    });

    it('failed cancel in ForSale: the bounce reopens the sale and the seller can retry', async () => {
        await depositNft();
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);

        const failed = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        expect(failed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: nft.address,
            success: false,
            exitCode: NftErrors.transfersRejected,
        });
        // NFT всё ещё у контракта, продажа не потеряна
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);

        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), false);
        await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        expect((await nft.getOwner()).equals(seller.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Cancelled);
    });

    it('failed cancel in WaitingNft: the bounce is ignored and the state is unchanged', async () => {
        await depositNft(0n);
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);

        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        // bounce пришёл и был обработан без ошибки
        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: true,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('withdraw after a sale: the seller gets the leftovers, the reserve stays', async () => {
        await depositNft();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
        const before = await balanceOf(giftSwap.address);
        expect(before).toBeGreaterThan(KEEP);

        const result = await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'));

        const payout = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(giftSwap.address) &&
                tx.inMessage.info.dest.equals(seller.address),
        )!;
        expect(payout).toBeDefined();
        // ушло почти всё, что было сверх резерва
        const sent = (payout.inMessage!.info as any).value.coins as bigint;
        expect(sent).toBeGreaterThan(before - KEEP - toNano('0.01'));
        const after = await balanceOf(giftSwap.address);
        expect(after).toBeGreaterThanOrEqual(KEEP);
        expect(after).toBeLessThan(KEEP + toNano('0.005'));
    });

    it('withdraw after cancel works', async () => {
        await depositNft();
        await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        const result = await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(KEEP);
    });

    it('withdraw in WaitingNft returns the deployment leftovers', async () => {
        const result = await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(KEEP);
    });

    it('attack: withdraw by a stranger is rejected and nothing leaves the contract', async () => {
        await depositNft();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const before = await balanceOf(giftSwap.address);

        const result = await giftSwap.sendWithdraw(attacker.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notSeller,
        });
        // Злоумышленнику уходит только bounce его собственных TON, а не остаток контракта.
        for (const tx of result.transactions) {
            const info = tx.inMessage?.info;
            if (info?.type === 'internal' && info.src.equals(giftSwap.address) && info.dest.equals(attacker.address)) {
                expect(info.bounced).toBe(true);
                expect(info.value.coins).toBeLessThanOrEqual(toNano('0.05'));
            }
        }
        // Деньги покупателя на месте: баланс не упал (кроме крошечной комиссии).
        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(before - toNano('0.001'));
    });

    it('withdraw is rejected while the NFT is for sale', async () => {
        await depositNft();

        const result = await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: seller.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
    });

    // ---------- Привязка ответов NFT к покупке и Settle ----------

    // query_id, с которым GiftSwap просил NFT о переводе (берём из исходящего сообщения).
    const transferQueryId = (txs: Transaction[]) => {
        const tx = txs.find(
            (t) =>
                t.inMessage?.info.type === 'internal' &&
                t.inMessage.info.src.equals(giftSwap.address) &&
                t.inMessage.info.dest.equals(nft.address),
        )!;
        const body = tx.inMessage!.body.beginParse();
        body.loadUint(32); // op
        return body.loadUintBig(64);
    };

    it('the deposit transfer may name the contract as response_destination: its excesses is harmless', async () => {
        // Продавец сам выбирает response_destination при депозите. Если указать GiftSwap,
        // NFT пришлёт ему ещё и excesses по депозиту. Он не должен ни ломать, ни подменять подтверждение покупки.
        const deposit = await nft.sendTransfer(seller.getSender(), toNano('0.1'), {
            newOwner: giftSwap.address,
            responseDestination: giftSwap.address,
            forwardAmount: toNano('0.05'),
        });
        expect(deposit.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            op: NftOpcodes.excesses,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);

        const sale = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        expect(sale.transactions).toHaveTransaction({ from: giftSwap.address, to: seller.address, value: PRICE });
        expect((await nft.getOwner()).equals(buyer.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('every transfer request gets a fresh query_id (a failed attempt and its retry differ)', async () => {
        await depositNft();
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);
        const failed = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), false);
        const retry = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const first = transferQueryId(failed.transactions);
        const second = transferQueryId(retry.transactions);
        expect(first).not.toBe(0n);
        expect(second).not.toBe(0n);
        expect(second).not.toBe(first);
    });

    it('settle is not needed in the normal flow and is rejected afterwards', async () => {
        await depositNft();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);

        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + Constants.settleTimeout + 1;
        const result = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
    });

    // ---------- Газ и константы ----------
    // Замеры на моке, повторяющем правило референсного NFT: любой обработчик GiftSwap стоит
    // не больше ~0.0004 TON, вся цепочка продажи ~0.0008 TON. Запас GAS_RESERVE должен быть
    // многократно больше. Эти тесты падают, если константы или код разойдутся с замерами.
    const HANDLER_BUDGET = GAS_RESERVE / 5n; // запас в 5 раз над измеренным максимумом

    // Сколько контракт заплатил за обработку сообщений, пришедших НА его адрес.
    const contractFee = (txs: Transaction[]) =>
        txs
            .filter((tx) => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.equals(giftSwap.address))
            .reduce((sum, tx) => sum + tx.totalFees.coins, 0n);

    const balanceDelta = async (run: () => Promise<unknown>) => {
        const before = await balanceOf(giftSwap.address);
        await run();
        return (await balanceOf(giftSwap.address)) - before;
    };

    it('gas budget: deposit, buy+confirmation and withdraw each cost less than GAS_RESERVE / 5', async () => {
        expect(contractFee((await depositNft()).transactions)).toBeLessThan(HANDLER_BUDGET);
        expect(contractFee((await giftSwap.sendBuy(buyer.getSender(), ENOUGH)).transactions)).toBeLessThan(
            HANDLER_BUDGET,
        );
        expect(contractFee((await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'))).transactions)).toBeLessThan(
            HANDLER_BUDGET,
        );
    });

    it('gas budget: cancel costs less than GAS_RESERVE / 5', async () => {
        await depositNft();
        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));
        expect(contractFee(result.transactions)).toBeLessThan(HANDLER_BUDGET);
    });

    it('gas budget: both bounce paths (failed buy, failed cancel) cost less than GAS_RESERVE / 5', async () => {
        await depositNft();
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);
        const failedBuy = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        expect(contractFee(failedBuy.transactions)).toBeLessThan(HANDLER_BUDGET);
        const failedCancel = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));
        expect(contractFee(failedCancel.transactions)).toBeLessThan(HANDLER_BUDGET);
    });

    it('reserve: a sale never drains the contract and does not overcharge the buyer beyond GAS_RESERVE', async () => {
        await depositNft();
        const delta = await balanceDelta(() => giftSwap.sendBuy(buyer.getSender(), ENOUGH));
        expect(delta).toBeGreaterThanOrEqual(0n);
        expect(delta).toBeLessThanOrEqual(GAS_RESERVE);
    });

    it('reserve: a sale with the minimal payment does not drain the contract either', async () => {
        await depositNft();
        const delta = await balanceDelta(() => giftSwap.sendBuy(buyer.getSender(), PRICE + FEES));
        expect(delta).toBeGreaterThanOrEqual(0n);
        expect(delta).toBeLessThanOrEqual(GAS_RESERVE);
    });

    it('reserve: a cancel with the minimal amount does not drain the contract', async () => {
        await depositNft();
        const delta = await balanceDelta(() => giftSwap.sendCancel(seller.getSender(), FEES));
        expect(delta).toBeGreaterThanOrEqual(0n);
        expect(delta).toBeLessThanOrEqual(GAS_RESERVE);
    });

    it('reserve: a failed buy does not drain the contract (repeated attempts cannot grief it)', async () => {
        await depositNft();
        await nft.sendSetReject(deployer.getSender(), toNano('0.05'), true);
        for (let i = 0; i < 3; i++) {
            const delta = await balanceDelta(() => giftSwap.sendBuy(buyer.getSender(), PRICE + FEES));
            expect(delta).toBeGreaterThanOrEqual(0n);
        }
    });

    it('NFT_TRANSFER_MIN has a large margin: an NFT in its steady state transfers with a tenth of it', async () => {
        // NFT после первого перевода держит ~0.05 TON (как в референсе), поэтому ему нужно совсем немного.
        await nft.sendTransfer(seller.getSender(), toNano('0.1'), {
            newOwner: attacker.address,
            responseDestination: seller.address,
            forwardAmount: toNano('0.05'),
        });
        await nft.sendTransfer(attacker.getSender(), Constants.nftTransferMin / 10n, {
            newOwner: buyer.address,
            responseDestination: attacker.address,
            forwardAmount: 0n,
        });
        expect((await nft.getOwner()).equals(buyer.address)).toBe(true);
    });

    it('deposit: a forward_amount of 0.01 TON is enough for the notification', async () => {
        await depositNft(toNano('0.01'));
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('deposit: a dust forward_amount is not enough (NFT stays unannounced; Cancel rescues it)', async () => {
        await depositNft(10_000n); // 0.00001 TON, меньше стоимости обработки уведомления
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
        expect((await nft.getOwner()).equals(giftSwap.address)).toBe(true);
    });

    it('WITHDRAW_KEEP covers 10 years of storage fees (re-measure it after any noticeable contract change)', async () => {
        await depositNft();
        blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + 10 * 365 * 24 * 3600;

        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        const tx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(giftSwap.address),
        )!;
        const storageFee = (tx.description as any).storagePhase?.storageFeesCollected as bigint;
        expect(storageFee).toBeGreaterThan(0n);
        expect(storageFee).toBeLessThanOrEqual(Constants.withdrawKeep);
    });

    it('repeated withdraw never drops the balance below the reserve', async () => {
        await depositNft();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        for (let i = 0; i < 3; i++) {
            await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'));
            expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(KEEP);
        }
    });
});
