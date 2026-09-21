import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Message, Transaction, toNano } from '@ton/core';
import {
    GiftSwap,
    Errors,
    Opcodes,
    Constants,
    SwapState,
    ownershipAssignedBody,
    excessesBody,
} from '../wrappers/GiftSwap';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('GiftSwap', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('GiftSwap');
    });

    const PRICE = toNano('1');
    const FEES = Constants.nftTransferMin + Constants.gasReserve; // NFT_TRANSFER_MIN + GAS_RESERVE
    const EXCESS = toNano('0.03'); // сколько NFT обычно возвращает из наших NFT_TRANSFER_MIN
    const ENOUGH = PRICE + FEES + toNano('0.1'); // с запасом

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    // В песочнице «NFT» — просто кошелёк: нам важен его адрес как отправителя уведомления.
    let nft: SandboxContract<TreasuryContract>;
    let otherNft: SandboxContract<TreasuryContract>;
    let giftSwap: SandboxContract<GiftSwap>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        seller = await blockchain.treasury('seller');
        buyer = await blockchain.treasury('buyer');
        attacker = await blockchain.treasury('attacker');
        nft = await blockchain.treasury('nft');
        otherNft = await blockchain.treasury('otherNft');

        giftSwap = blockchain.openContract(
            GiftSwap.createFromConfig(
                { seller: seller.address, nftAddress: nft.address, price: PRICE },
                code,
            ),
        );

        const deployResult = await giftSwap.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: giftSwap.address,
            deploy: true,
            success: true,
        });
    });

    // Имитация: NFT-контракт `from` шлёт нашему контракту уведомление OwnershipAssigned.
    async function notify(from: SandboxContract<TreasuryContract>, prevOwner: Address) {
        return from.send({
            to: giftSwap.address,
            value: toNano('0.05'),
            bounce: false,
            body: ownershipAssignedBody(prevOwner),
        });
    }

    // Приводит контракт в состояние ForSale.
    async function deposit() {
        await notify(nft, seller.address);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    }

    // Имитация: NFT-контракт `from` подтверждает перевод сообщением excesses.
    // По умолчанию query_id берётся из контракта: настоящий NFT возвращает тот query_id, что получил в transfer.
    async function confirm(from: SandboxContract<TreasuryContract> = nft, value: bigint = EXCESS, queryId?: bigint) {
        const id = queryId ?? (await giftSwap.getSwapInfo()).queryId;
        return from.send({
            to: giftSwap.address,
            value,
            bounce: false,
            body: excessesBody(id),
        });
    }

    // Имитация bounce: сеть возвращает GiftSwap его же сообщение (перевод NFT), которое NFT не смог обработать.
    // Тело bounce: 0xFFFFFFFF + первые 256 бит исходного тела (у нас это код операции и query_id).
    function bouncedTransfer(src: Address, queryId: bigint, op: number = Opcodes.nftTransfer): Message {
        return {
            info: {
                type: 'internal',
                ihrDisabled: true,
                bounce: false,
                bounced: true,
                src,
                dest: giftSwap.address,
                value: { coins: toNano('0.05') },
                ihrFee: 0n,
                forwardFee: 0n,
                createdLt: 0n,
                createdAt: 0,
            },
            body: beginCell().storeUint(0xffffffff, 32).storeUint(op, 32).storeUint(queryId, 64).endCell(),
        };
    }

    // Достаёт код операции из тела сообщения.
    function opOf(tx: Transaction, index = 0): number {
        return tx.outMessages.get(index)!.body.beginParse().loadUint(32);
    }

    // ---------- Базовое ----------

    it('should deploy in WaitingNft state', async () => {
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.WaitingNft);
        expect(info.seller.equals(seller.address)).toBe(true);
        expect(info.nftAddress.equals(nft.address)).toBe(true);
        expect(info.price).toBe(PRICE);
    });

    it('should accept the NFT from the seller', async () => {
        const result = await notify(nft, seller.address);
        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: true,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    // ---------- Атака: поддельное уведомление / чужой NFT ----------

    it('rejects a fake notification from a random wallet', async () => {
        const result = await notify(attacker, seller.address);
        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notExpectedNft,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('rejects a notification from a different NFT (foreign NFT)', async () => {
        const result = await notify(otherNft, seller.address);
        expect(result.transactions).toHaveTransaction({
            from: otherNft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notExpectedNft,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('rejects the right NFT if it was sent by someone other than the seller', async () => {
        const result = await notify(nft, attacker.address);
        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notSeller,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('rejects a second deposit notification', async () => {
        await deposit();
        const result = await notify(nft, seller.address);
        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
    });

    // ---------- Покупка ----------

    it('rejects buying before the NFT is deposited', async () => {
        const result = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
    });

    it('buy: money is held, NFT transfer is requested with the contract as response_destination', async () => {
        await deposit();

        const result = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const nftTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(giftSwap.address) &&
                tx.inMessage.info.dest.equals(nft.address),
        )!;
        expect(nftTx).toBeDefined();
        const body = nftTx.inMessage!.body.beginParse();
        expect(body.loadUint(32)).toBe(Opcodes.nftTransfer);
        body.loadUint(64); // query_id
        expect(body.loadAddress().equals(buyer.address)).toBe(true); // new_owner
        // excesses должен вернуться к нам: это и есть подтверждение перевода
        expect(body.loadAddress().equals(giftSwap.address)).toBe(true); // response_destination

        // Продавцу пока НЕ платим: ждём подтверждения от NFT
        expect(result.transactions).not.toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.Transferring);
        expect(info.buyer!.equals(buyer.address)).toBe(true);
        expect(info.paid).toBe(ENOUGH);
    });

    it('confirmation: excesses from the NFT pays the seller and refunds the surplus', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const result = await confirm();

        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            op: Opcodes.excesses,
            success: true,
        });
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
            value: PRICE,
        });
        // возврат = оплачено - цена - (NFT_TRANSFER_MIN + GAS_RESERVE) + то, что NFT вернул из NFT_TRANSFER_MIN
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - PRICE - FEES + EXCESS,
        });
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.Sold);
        expect(info.buyer).toBeNull();
        expect(info.paid).toBe(0n);
    });

    it('attack: fake excesses from a random wallet does not pay the seller', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const result = await confirm(attacker);

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notExpectedNft,
        });
        expect(result.transactions).not.toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    it('attack: excesses without a purchase in progress is rejected', async () => {
        await deposit();

        const result = await confirm();

        expect(result.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('attack: repeated excesses does not pay the seller twice', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await confirm();

        const again = await confirm();

        expect(again.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(again.transactions).not.toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
    });

    it('rejects a repeated purchase (while Transferring and after Sold) and does not pay twice', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        // пока идёт перевод
        const during = await giftSwap.sendBuy(attacker.getSender(), ENOUGH);
        expect(during.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });

        // после продажи
        await confirm();
        const after = await giftSwap.sendBuy(attacker.getSender(), ENOUGH);
        expect(after.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(after.transactions).not.toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
    });

    it('withdraw is rejected while a purchase is in progress: the buyer money stays and the sale completes', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const before = (await blockchain.getContract(giftSwap.address)).balance;

        const result = await giftSwap.sendWithdraw(seller.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: seller.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect((await blockchain.getContract(giftSwap.address)).balance).toBeGreaterThanOrEqual(before);

        const confirmed = await confirm();
        expect(confirmed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
            value: PRICE,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('rejects cancel after the NFT is sold', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await confirm();

        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        expect(result.transactions).toHaveTransaction({
            from: seller.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('rejects cancel while a purchase is in progress', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        expect(result.transactions).toHaveTransaction({
            from: seller.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    // ---------- Атака: неверная сумма ----------

    it('rejects a payment that is less than the price', async () => {
        await deposit();
        const result = await giftSwap.sendBuy(buyer.getSender(), PRICE - toNano('0.5'));
        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongAmount,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('rejects exactly the price without fees for the NFT transfer', async () => {
        await deposit();
        const result = await giftSwap.sendBuy(buyer.getSender(), PRICE);
        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongAmount,
        });
        expect(result.transactions).not.toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('accepts the minimal valid payment (price + fees): the buyer gets back exactly what the NFT returned', async () => {
        await deposit();
        const result = await giftSwap.sendBuy(buyer.getSender(), PRICE + FEES);
        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: true,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);

        const confirmed = await confirm();
        expect(confirmed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
            value: PRICE,
        });
        // без излишка сверх минимума покупатель получает только то, что NFT вернул из наших NFT_TRANSFER_MIN
        expect(confirmed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: EXCESS,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('refund to the buyer is capped: TON the NFT returns beyond NFT_TRANSFER_MIN stay for the seller', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), PRICE + FEES);

        // NFT «вернул» 0.2 TON (например, свой избыточный баланс), а мы отправили ему только 0.05
        const confirmed = await confirm(nft, toNano('0.2'));

        expect(confirmed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: Constants.nftTransferMin, // не 0.2
        });
    });

    it('if the NFT returns almost nothing, the buyer pays that NFT cost and the contract stays solvent', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const small = toNano('0.001');
        const confirmed = await confirm(nft, small);

        expect(confirmed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: seller.address,
            value: PRICE,
        });
        expect(confirmed.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - PRICE - FEES + small,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    // ---------- Отмена ----------

    it('lets the seller cancel and get the NFT back', async () => {
        await deposit();
        const result = await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));

        const nftTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(giftSwap.address) &&
                tx.inMessage.info.dest.equals(nft.address),
        )!;
        expect(nftTx).toBeDefined();
        const body = nftTx.inMessage!.body.beginParse();
        expect(body.loadUint(32)).toBe(Opcodes.nftTransfer);
        body.loadUint(64);
        expect(body.loadAddress().equals(seller.address)).toBe(true); // new_owner

        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Cancelled);
    });

    it('rejects cancel from someone other than the seller', async () => {
        await deposit();
        const result = await giftSwap.sendCancel(attacker.getSender(), toNano('0.1'));
        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notSeller,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('rejects buying after cancel', async () => {
        await deposit();
        await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));
        const result = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
    });

    // ---------- Привязка ответов NFT к покупке (query_id) ----------

    it('the purchase transfer carries a contract-generated query_id (the buyer has no say)', async () => {
        await deposit();
        const result = await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const info = await giftSwap.getSwapInfo();
        expect(info.queryId).not.toBe(0n);
        const nftTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(giftSwap.address) &&
                tx.inMessage.info.dest.equals(nft.address),
        )!;
        const body = nftTx.inMessage!.body.beginParse();
        body.loadUint(32); // op
        expect(body.loadUintBig(64)).toBe(info.queryId);
    });

    it('attack: an excesses with a foreign query_id is rejected; the right one then completes the sale', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const stale = await confirm(nft, EXCESS, 999_999n);
        expect(stale.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongQueryId,
        });
        expect(stale.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);

        const right = await confirm();
        expect(right.transactions).toHaveTransaction({ from: giftSwap.address, to: seller.address, value: PRICE });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('attack: a bounce with a foreign query_id is ignored; the right one refunds the buyer', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();

        const foreign = await blockchain.sendMessage(bouncedTransfer(nft.address, 555n));
        expect(foreign.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);

        const real = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId));
        expect(real.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - Constants.gasReserve,
        });
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.ForSale);
        expect(info.buyer).toBeNull();
        expect(info.queryId).toBe(0n);
    });

    it('attack: a bounce that did not come from the NFT is ignored', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();

        const result = await blockchain.sendMessage(bouncedTransfer(attacker.address, queryId));

        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    it('a bounce of some other kind of message (foreign opcode) is ignored', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();

        const result = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId, 0x12345678));

        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    it('race: a stale bounce of a Cancel sent in WaitingNft cannot cancel a later purchase', async () => {
        // 1) Cancel в WaitingNft: контракт запоминает query_id этого перевода
        await giftSwap.sendCancel(seller.getSender(), toNano('0.1'));
        const staleQueryId = (await giftSwap.getSwapInfo()).queryId;
        expect(staleQueryId).not.toBe(0n);
        // 2) депозит догнал, потом покупка
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const current = await giftSwap.getSwapInfo();
        expect(current.state).toBe(SwapState.Transferring);
        expect(current.queryId).not.toBe(staleQueryId);

        // 3) опоздавший bounce от Cancel из шага 1 не должен принять за провал покупки
        const result = await blockchain.sendMessage(bouncedTransfer(nft.address, staleQueryId));

        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
        // настоящее подтверждение перевода по-прежнему завершает продажу
        await confirm();
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('a stale bounce after the sale is over changes nothing', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();
        await confirm();

        const result = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId));

        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    // ---------- Settle: выход из Transferring, если NFT молчит ----------

    it('settle before the timeout is rejected', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const result = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.tooEarly,
        });
        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    it('settle works exactly at the deadline (one second earlier it does not) and completes the sale', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { settleAfter } = await giftSwap.getSwapInfo();
        expect(settleAfter).toBeGreaterThan(0);

        blockchain.now = settleAfter - 1;
        const early = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));
        expect(early.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.tooEarly,
        });

        blockchain.now = settleAfter;
        const result = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));

        // NFT молчал, но bounce не было: перевод считается выполненным. Продавцу платим цену,
        // покупателю возвращаем излишек без зачёта возврата от NFT (его нет).
        expect(result.transactions).toHaveTransaction({ from: giftSwap.address, to: seller.address, value: PRICE });
        expect(result.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - PRICE - FEES,
        });
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.Sold);
        expect(info.buyer).toBeNull();
        expect(info.paid).toBe(0n);
        expect(info.queryId).toBe(0n);
        expect(info.settleAfter).toBe(0);
    });

    it('settle is rejected when no purchase is in progress (ForSale and Sold)', async () => {
        await deposit();
        const forSale = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));
        expect(forSale.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });

        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await confirm();
        const sold = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));
        expect(sold.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(sold.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
    });

    it('a late excesses or bounce after settle pays nothing and changes nothing', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId, settleAfter } = await giftSwap.getSwapInfo();
        blockchain.now = settleAfter;
        await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));

        const lateExcesses = await confirm(nft, EXCESS, queryId);
        expect(lateExcesses.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(lateExcesses.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });

        const lateBounce = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId));
        expect(lateBounce.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('gas budget: settle costs less than GAS_RESERVE / 5', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        blockchain.now = (await giftSwap.getSwapInfo()).settleAfter;

        const result = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));

        const fee = result.transactions
            .filter((tx) => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.equals(giftSwap.address))
            .reduce((sum, tx) => sum + tx.totalFees.coins, 0n);
        expect(fee).toBeLessThan(Constants.gasReserve / 5n);
    });

    // ---------- Прочее ----------

    it('rejects an unknown message but accepts an empty top-up', async () => {
        const unknown = await deployer.send({
            to: giftSwap.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0xdeadbeef, 32).endCell(),
        });
        expect(unknown.transactions).toHaveTransaction({
            from: deployer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.unknownOp,
        });

        const topUp = await deployer.send({ to: giftSwap.address, value: toNano('0.05') });
        expect(topUp.transactions).toHaveTransaction({
            from: deployer.address,
            to: giftSwap.address,
            success: true,
        });
    });
});
