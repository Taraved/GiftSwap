import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';

// Должно совпадать с enum State в contracts/gift_swap.tolk
export enum SwapState {
    WaitingNft = 0,
    ForSale = 1,
    Transferring = 2, // покупатель заплатил, ждём подтверждения перевода NFT
    Sold = 3,
    Cancelled = 4,
}

// Должно совпадать с кодами операций в contracts/gift_swap.tolk
export const Opcodes = {
    ownershipAssigned: 0x05138d91, // TEP-62: уведомление от NFT
    nftTransfer: 0x5fcc3d14, // TEP-62: перевод NFT
    excesses: 0xd53276db, // TEP-62: NFT подтверждает успешный перевод
    getStaticData: 0x2fcb26a2, // TEP-62: запрос к NFT (им Settle проверяет, что перевод обработан)
    reportStaticData: 0x8b771735, // TEP-62: ответ NFT на get_static_data
    buy: 0x0b5a0001,
    cancel: 0x0b5a0002,
    withdraw: 0x0b5a0003,
    settle: 0x0b5a0004,
    refund: 0x0b5a0005,
};

// Должно совпадать с константами в contracts/gift_swap.tolk (замеры: tests/GiftSwapWithNft.spec.ts, раздел «Газ и константы»)
export const Constants = {
    nftTransferMin: toNano('0.05'), // NFT_TRANSFER_MIN: сколько прикладываем к переводу NFT
    gasReserve: toNano('0.01'), // GAS_RESERVE: запас контракта на газ и комиссии
    withdrawKeep: toNano('0.02'), // WITHDRAW_KEEP: остаток после Withdraw (плата за хранение)
    nftReturnMin: toNano('0.01'), // NFT_RETURN_MIN: с меньшей суммой в уведомлении ненужный NFT не возвращается
    withdrawMin: toNano('0.005'), // WITHDRAW_MIN: меньший остаток сверх WITHDRAW_KEEP Withdraw не выводит
    settleMin: toNano('0.01'), // SETTLE_MIN: минимум TON в Settle (оплачивает запрос к NFT и ответ)
    refundTimeout: 30 * 24 * 3600, // REFUND_TIMEOUT, секунды: через столько после первого Settle без ответа NFT работает Refund
};

// Должно совпадать с ERR_* в contracts/gift_swap.tolk
export const Errors = {
    notExpectedNft: 101,
    notSeller: 102,
    wrongState: 103,
    wrongAmount: 104,
    wrongQueryId: 105,
    tooEarly: 106,
    nothingToWithdraw: 107,
    unknownOp: 0xffff,
};

export type GiftSwapConfig = {
    seller: Address;
    nftAddress: Address;
    price: bigint;
};

// Начальное хранилище. Порядок полей — как в struct Storage.
export function giftSwapConfigToCell(config: GiftSwapConfig): Cell {
    return beginCell()
        .storeUint(SwapState.WaitingNft, 8)
        .storeAddress(config.seller)
        .storeAddress(config.nftAddress)
        .storeCoins(config.price)
        .storeUint(0, 64) // pendingQueryId: пока нет перевода NFT в пути
        .storeMaybeRef(null) // purchase: пока покупки нет
        .endCell();
}

// ---------- Тела сообщений (общие для обёртки и тестов) ----------
// Сообщения пользователей состоят только из кода операции: query_id перевода выбирает сам контракт.
export const buyBody = (): Cell => beginCell().storeUint(Opcodes.buy, 32).endCell();
export const cancelBody = (): Cell => beginCell().storeUint(Opcodes.cancel, 32).endCell();
export const withdrawBody = (): Cell => beginCell().storeUint(Opcodes.withdraw, 32).endCell();
export const settleBody = (): Cell => beginCell().storeUint(Opcodes.settle, 32).endCell();
export const refundBody = (): Cell => beginCell().storeUint(Opcodes.refund, 32).endCell();

// Тело ответа NFT на get_static_data (TEP-62): query_id, index, collection. Нужно для тестов.
export function reportStaticDataBody(queryId: bigint, index = 0n, collection: Address | null = null): Cell {
    return beginCell()
        .storeUint(Opcodes.reportStaticData, 32)
        .storeUint(queryId, 64)
        .storeUint(index, 256)
        .storeAddress(collection)
        .endCell();
}

export type NftTransferParams = {
    newOwner: Address;
    responseDestination: Address;
    forwardAmount: bigint;
    queryId?: bigint;
};

// Стандартное сообщение transfer из TEP-62: так владелец передаёт NFT (например, на адрес GiftSwap).
// forwardAmount должен быть больше 0, иначе NFT не пришлёт контракту уведомление о депозите.
export function nftTransferBody(params: NftTransferParams): Cell {
    return beginCell()
        .storeUint(Opcodes.nftTransfer, 32)
        .storeUint(params.queryId ?? 0n, 64)
        .storeAddress(params.newOwner)
        .storeAddress(params.responseDestination)
        .storeMaybeRef(null) // custom_payload
        .storeCoins(params.forwardAmount)
        .storeBit(0) // forward_payload: пустой inline
        .endCell();
}

// Тело сообщения excesses, которым NFT подтверждает успешный перевод (нужно для тестов).
export function excessesBody(queryId: bigint = 0n): Cell {
    return beginCell().storeUint(Opcodes.excesses, 32).storeUint(queryId, 64).endCell();
}

// Тело уведомления, которое настоящий NFT шлёт новому владельцу (нужно для тестов).
export function ownershipAssignedBody(prevOwner: Address, queryId: bigint = 0n): Cell {
    return beginCell()
        .storeUint(Opcodes.ownershipAssigned, 32)
        .storeUint(queryId, 64)
        .storeAddress(prevOwner)
        .storeBit(0) // forward_payload: пустой inline
        .endCell();
}

export type SwapInfo = {
    state: SwapState;
    seller: Address;
    nftAddress: Address;
    price: bigint;
    buyer: Address | null;
    paid: bigint;
    queryId: bigint; // query_id текущего перевода NFT (его выбирает контракт); 0, если перевода нет
    refundAfter: number; // unixtime, с которого работает Refund; 0, если Settle ещё не отправлял запрос к NFT
};

export class GiftSwap implements Contract {
    abi: ContractABI = { name: 'GiftSwap' }

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new GiftSwap(address);
    }

    static createFromConfig(config: GiftSwapConfig, code: Cell, workchain = 0) {
        const data = giftSwapConfigToCell(config);
        const init = { code, data };
        return new GiftSwap(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendBuy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buyBody(),
        });
    }

    async sendCancel(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: cancelBody(),
        });
    }

    async sendWithdraw(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: withdrawBody(),
        });
    }

    // Settle может отправить любой и в любой момент покупки (value >= Constants.settleMin):
    // контракт спросит NFT get_static_data, и ответ NFT завершит сделку.
    async sendSettle(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: settleBody(),
        });
    }

    // Refund может отправить любой, но только через Constants.refundTimeout после первого Settle,
    // на который NFT так и не ответил: деньги возвращаются покупателю.
    async sendRefund(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: refundBody(),
        });
    }

    async getSwapInfo(provider: ContractProvider): Promise<SwapInfo> {
        const { stack } = await provider.get('swapInfo', []);
        return {
            state: stack.readNumber() as SwapState,
            seller: stack.readAddress(),
            nftAddress: stack.readAddress(),
            price: stack.readBigNumber(),
            buyer: stack.readAddressOpt(),
            paid: stack.readBigNumber(),
            queryId: stack.readBigNumber(),
            refundAfter: stack.readNumber(),
        };
    }
}
