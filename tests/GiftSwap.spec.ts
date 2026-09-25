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
    reportStaticDataBody,
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
        // Фиксированное время: без него плата за хранение зависит от того, успела ли пройти секунда между транзакциями.
        blockchain.now = 1_800_000_000;

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
    async function notify(from: SandboxContract<TreasuryContract>, prevOwner: Address, value = toNano('0.05')) {
        return from.send({
            to: giftSwap.address,
            value,
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

    // Просьбы GiftSwap к адресу `to` перевести NFT (op transfer): кому и куда вернуть излишек.
    function transferRequests(transactions: Transaction[], to: Address) {
        return transactions.flatMap((tx) => {
            const info = tx.inMessage?.info;
            if (info?.type !== 'internal' || !info.src.equals(giftSwap.address) || !info.dest.equals(to)) {
                return [];
            }
            const body = tx.inMessage!.body.beginParse();
            if (body.remainingBits < 32 || body.loadUint(32) !== Opcodes.nftTransfer) {
                return [];
            }
            body.loadUint(64); // query_id
            return [{ newOwner: body.loadAddress(), responseDestination: body.loadAddress() }];
        });
    }

    const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;

    // Приводит контракт в состояние Sold.
    async function sell() {
        await deposit();
        await sellAfterDeposit();
    }

    // Из ForSale в Sold: покупка и подтверждение от NFT.
    async function sellAfterDeposit() {
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await confirm();
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
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
    // Уведомление, которое не является депозитом, сделку не меняет. Если с ним пришло не меньше
    // NFT_RETURN_MIN, NFT отправляется обратно prevOwner за счёт TON самого уведомления.

    it('attack: a fake notification from a random wallet changes nothing; the "return" goes to the sender, not to our NFT', async () => {
        const before = await balanceOf(giftSwap.address);

        const result = await notify(attacker, seller.address);

        // Просьба «перевести NFT» ушла отправителю уведомления, то есть самому злоумышленнику.
        expect(transferRequests(result.transactions, attacker.address)).toHaveLength(1);
        expect(transferRequests(result.transactions, nft.address)).toHaveLength(0);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(before - toNano('0.0001'));
    });

    it('attack: a fake notification while the NFT is for sale cannot make the contract move that NFT', async () => {
        await deposit();

        const result = await notify(attacker, attacker.address);

        expect(transferRequests(result.transactions, nft.address)).toHaveLength(0);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('a foreign NFT is sent back to its previous owner', async () => {
        const result = await notify(otherNft, attacker.address);

        expect(result.transactions).toHaveTransaction({ from: otherNft.address, to: giftSwap.address, success: true });
        const requests = transferRequests(result.transactions, otherNft.address);
        expect(requests).toHaveLength(1);
        expect(requests[0].newOwner.equals(attacker.address)).toBe(true);
        expect(requests[0].responseDestination.equals(attacker.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('the right NFT sent by someone other than the seller goes back to that sender, not to the seller', async () => {
        const result = await notify(nft, attacker.address);

        const requests = transferRequests(result.transactions, nft.address);
        expect(requests).toHaveLength(1);
        expect(requests[0].newOwner.equals(attacker.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.WaitingNft);
    });

    it('after the sale, the NFT sent back to the contract is returned to the sender', async () => {
        await sell();

        const result = await notify(nft, buyer.address);

        const requests = transferRequests(result.transactions, nft.address);
        expect(requests).toHaveLength(1);
        expect(requests[0].newOwner.equals(buyer.address)).toBe(true);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('rejects a second deposit notification in ForSale and never gives away the NFT for sale', async () => {
        await deposit();
        const forSale = await notify(nft, attacker.address);
        expect(forSale.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });

        expect(transferRequests(forSale.transactions, nft.address)).toHaveLength(0);
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('during a purchase, our NFT sent to the contract is returned to its sender (our transfer was already done)', async () => {
        // Пока контракт владеет NFT, никто другой не может прислать его нам. Значит, уведомление от нашего NFT
        // во время покупки приходит, только когда наш перевод покупателю уже выполнен: NFT принадлежит отправителю.
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const result = await notify(nft, buyer.address);

        const requests = transferRequests(result.transactions, nft.address);
        expect(requests).toHaveLength(1);
        expect(requests[0].newOwner.equals(buyer.address)).toBe(true);
        // Сделку это не меняет: её закроет Excesses или Settle.
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
        await confirm();
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('with less than NFT_RETURN_MIN there is nothing to pay the return with: rejected as before (101, 102, 103)', async () => {
        const tiny = Constants.nftReturnMin - 1n;
        const expectRejected = (transactions: Transaction[], from: Address, exitCode: number) => {
            expect(transactions).toHaveTransaction({ from, to: giftSwap.address, success: false, exitCode });
            expect(transferRequests(transactions, from)).toHaveLength(0);
        };

        expectRejected((await notify(otherNft, attacker.address, tiny)).transactions, otherNft.address, Errors.notExpectedNft);
        expectRejected((await notify(nft, attacker.address, tiny)).transactions, nft.address, Errors.notSeller);
        await sell();
        expectRejected((await notify(nft, buyer.address, tiny)).transactions, nft.address, Errors.wrongState);
    });

    it('attack: a spam of fake notifications does not lower the contract balance', async () => {
        await sell(); // на контракте остаток продавца
        const before = await balanceOf(giftSwap.address);

        for (let i = 0; i < 3; i++) {
            await notify(attacker, attacker.address, Constants.nftReturnMin);
            await notify(attacker, attacker.address, toNano('0.5'));
            await notify(attacker, attacker.address, Constants.nftReturnMin - 1n);
        }

        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(before - toNano('0.0001'));
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
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

    // ---------- Settle: проверочный запрос к NFT вместо ожидания по таймеру ----------
    // Settle просит NFT get_static_data. Контракт отправил его ПОСЛЕ перевода, а сообщения между двумя
    // контрактами обрабатываются по порядку (спецификация TON, 2.2.10): NFT сначала обработает перевод,
    // и его ответ на перевод (bounce или excesses) придёт к нам раньше ответа на запрос. Поэтому ответ
    // на запрос, пришедший во время покупки, доказывает: перевод обработан и не отвергнут.

    // Просьбы GiftSwap к NFT get_static_data: их query_id.
    function probes(transactions: Transaction[]) {
        return transactions.flatMap((tx) => {
            const info = tx.inMessage?.info;
            if (info?.type !== 'internal' || !info.src.equals(giftSwap.address) || !info.dest.equals(nft.address)) {
                return [];
            }
            const body = tx.inMessage!.body.beginParse();
            if (body.remainingBits < 32 || body.loadUint(32) !== Opcodes.getStaticData) {
                return [];
            }
            return [body.loadUintBig(64)];
        });
    }

    // Имитация ответа NFT (или подделки от `from`) на get_static_data.
    async function report(from: SandboxContract<TreasuryContract> = nft, queryId?: bigint) {
        const id = queryId ?? (await giftSwap.getSwapInfo()).queryId;
        return from.send({ to: giftSwap.address, value: toNano('0.009'), bounce: false, body: reportStaticDataBody(id) });
    }

    const NOW = 1_800_000_000;
    const DAY = 24 * 3600;

    it('settle right after the buy (no waiting) sends get_static_data with the query_id of the transfer', async () => {
        blockchain.now = NOW;
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();

        const result = await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin);

        expect(probes(result.transactions)).toEqual([queryId]);
        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.Transferring);
        expect(info.refundAfter).toBe(NOW + Constants.refundTimeout);
    });

    it('the answer of the NFT to the probe completes the sale', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin);

        const result = await report();

        // Продавцу цена, покупателю излишек без зачёта возврата от NFT (excesses не было).
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
        expect(info.refundAfter).toBe(0);
    });

    it('a bounced probe also completes the sale: the NFT processed the transfer before it and did not bounce it', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin);
        const { queryId } = await giftSwap.getSwapInfo();

        const result = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId, Opcodes.getStaticData));

        expect(result.transactions).toHaveTransaction({ from: giftSwap.address, to: seller.address, value: PRICE });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Sold);
    });

    it('order: a transfer bounce that comes before the probe answer refunds the buyer; the answer is then ignored', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin);
        const { queryId } = await giftSwap.getSwapInfo();

        const bounce = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId));
        expect(bounce.transactions).toHaveTransaction({
            from: giftSwap.address,
            to: buyer.address,
            value: ENOUGH - Constants.gasReserve,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);

        const lateAnswer = await report(nft, queryId);
        expect(lateAnswer.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(lateAnswer.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('attack: a fake probe answer does not pay the seller (random wallet, foreign query_id, no purchase)', async () => {
        await deposit();
        const noPurchase = await report(nft, 0n);
        expect(noPurchase.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });

        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();
        const fromStranger = await report(attacker, queryId);
        expect(fromStranger.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.notExpectedNft,
        });
        const foreignId = await report(nft, queryId + 1n);
        expect(foreignId.transactions).toHaveTransaction({
            from: nft.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongQueryId,
        });
        const bouncedForeign = await blockchain.sendMessage(
            bouncedTransfer(nft.address, queryId + 1n, Opcodes.getStaticData),
        );

        for (const r of [fromStranger, foreignId, bouncedForeign]) {
            expect(r.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
        }
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
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

        await sellAfterDeposit();
        const sold = await giftSwap.sendSettle(attacker.getSender(), toNano('0.05'));
        expect(sold.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(probes([...forSale.transactions, ...sold.transactions])).toHaveLength(0);
    });

    it('settle with less than SETTLE_MIN is rejected: the probe and its answer must be paid by the caller', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        const result = await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin - 1n);

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongAmount,
        });
        expect(probes(result.transactions)).toHaveLength(0);
        expect((await giftSwap.getSwapInfo()).refundAfter).toBe(0);
    });

    it('attack: a spam of settle calls does not lower the contract balance (the caller pays each probe)', async () => {
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const before = await balanceOf(giftSwap.address);

        for (let i = 0; i < 5; i++) {
            await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin);
        }

        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(before - toNano('0.0001'));
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    // ---------- Refund: резервный выход, если NFT не отвечает вообще ----------

    it('refund works only 30 days after the FIRST unanswered probe; later settles do not move the deadline', async () => {
        blockchain.now = NOW;
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await giftSwap.sendSettle(buyer.getSender(), Constants.settleMin); // NFT (заглушка) молчит

        blockchain.now = NOW + 10 * DAY;
        await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin); // не сдвигает срок
        expect((await giftSwap.getSwapInfo()).refundAfter).toBe(NOW + Constants.refundTimeout);

        blockchain.now = NOW + Constants.refundTimeout - 1;
        const early = await giftSwap.sendRefund(attacker.getSender(), toNano('0.05'));
        expect(early.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.tooEarly,
        });

        blockchain.now = NOW + Constants.refundTimeout;
        const result = await giftSwap.sendRefund(attacker.getSender(), toNano('0.05'));

        // Покупателю возвращается всё, кроме того, что ушло на перевод NFT, и запаса на газ.
        expect(result.transactions).toHaveTransaction({ from: giftSwap.address, to: buyer.address, value: ENOUGH - FEES });
        expect(result.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
        const info = await giftSwap.getSwapInfo();
        expect(info.state).toBe(SwapState.ForSale);
        expect(info.buyer).toBeNull();
        expect(info.queryId).toBe(0n);
        expect(info.refundAfter).toBe(0);
    });

    it('refund is never possible without a probe, however long the purchase lasts', async () => {
        blockchain.now = NOW;
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        blockchain.now = NOW + 365 * DAY;
        const result = await giftSwap.sendRefund(buyer.getSender(), toNano('0.05'));

        expect(result.transactions).toHaveTransaction({
            from: buyer.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.tooEarly,
        });
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.Transferring);
    });

    it('refund is rejected when no purchase is in progress (ForSale and Sold)', async () => {
        await deposit();
        const forSale = await giftSwap.sendRefund(attacker.getSender(), toNano('0.05'));
        expect(forSale.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });

        await sellAfterDeposit();
        const sold = await giftSwap.sendRefund(attacker.getSender(), toNano('0.05'));
        expect(sold.transactions).toHaveTransaction({
            from: attacker.address,
            to: giftSwap.address,
            success: false,
            exitCode: Errors.wrongState,
        });
        expect(sold.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
    });

    it('after a refund, a late answer, excesses or bounce pays nothing and changes nothing', async () => {
        blockchain.now = NOW;
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        const { queryId } = await giftSwap.getSwapInfo();
        await giftSwap.sendSettle(buyer.getSender(), Constants.settleMin);
        blockchain.now = NOW + Constants.refundTimeout;
        await giftSwap.sendRefund(buyer.getSender(), toNano('0.05'));

        const lateAnswer = await report(nft, queryId);
        const lateExcesses = await confirm(nft, EXCESS, queryId);
        const lateBounce = await blockchain.sendMessage(bouncedTransfer(nft.address, queryId));

        for (const r of [lateAnswer, lateExcesses, lateBounce]) {
            expect(r.transactions).not.toHaveTransaction({ from: giftSwap.address, to: seller.address });
            expect(r.transactions).not.toHaveTransaction({ from: giftSwap.address, to: buyer.address });
        }
        expect((await giftSwap.getSwapInfo()).state).toBe(SwapState.ForSale);
    });

    it('reserve: buy + settle + refund does not drain the contract', async () => {
        blockchain.now = NOW;
        await deposit();
        const before = await balanceOf(giftSwap.address);

        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await giftSwap.sendSettle(buyer.getSender(), Constants.settleMin);
        blockchain.now = NOW + Constants.refundTimeout;
        await giftSwap.sendRefund(buyer.getSender(), toNano('0.05'));

        expect(await balanceOf(giftSwap.address)).toBeGreaterThanOrEqual(before);
    });

    it('gas budget: settle, the answer and refund each cost less than GAS_RESERVE / 5', async () => {
        const fee = (transactions: Transaction[]) =>
            transactions
                .filter((tx) => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.equals(giftSwap.address))
                .reduce((sum, tx) => sum + tx.totalFees.coins, 0n);
        blockchain.now = NOW;
        await deposit();
        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);

        expect(fee((await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin)).transactions)).toBeLessThan(
            Constants.gasReserve / 5n,
        );
        blockchain.now = NOW + Constants.refundTimeout;
        expect(fee((await giftSwap.sendRefund(attacker.getSender(), toNano('0.05'))).transactions)).toBeLessThan(
            Constants.gasReserve / 5n,
        );

        await giftSwap.sendBuy(buyer.getSender(), ENOUGH);
        await giftSwap.sendSettle(attacker.getSender(), Constants.settleMin);
        expect(fee((await report()).transactions)).toBeLessThan(Constants.gasReserve / 5n);
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
