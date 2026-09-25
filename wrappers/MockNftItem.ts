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
} from '@ton/core';
import { NftTransferParams, nftTransferBody } from './GiftSwap';

// Обёртка тестового NFT (contracts/mock_nft_item.tolk). Только для тестов.

export const NftOpcodes = {
    transfer: 0x5fcc3d14,
    ownershipAssigned: 0x05138d91,
    excesses: 0xd53276db,
    getStaticData: 0x2fcb26a2,
    reportStaticData: 0x8b771735,
};

export const NftErrors = {
    notOwner: 401,
    notEnoughValue: 402,
    transfersRejected: 403,
};

export type MockNftItemConfig = {
    owner: Address;
};

export function mockNftItemConfigToCell(config: MockNftItemConfig): Cell {
    return beginCell().storeAddress(config.owner).storeBit(false).storeBit(false).endCell(); // owner, rejectTransfers, skipExcesses
}

export class MockNftItem implements Contract {
    abi: ContractABI = { name: 'MockNftItem' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(config: MockNftItemConfig, code: Cell, workchain = 0) {
        const data = mockNftItemConfigToCell(config);
        const init = { code, data };
        return new MockNftItem(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // transfer из TEP-62: так владелец передаёт NFT (например, на адрес GiftSwap).
    async sendTransfer(provider: ContractProvider, via: Sender, value: bigint, params: NftTransferParams) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: nftTransferBody(params),
        });
    }

    // ТОЛЬКО ДЛЯ ТЕСТОВ: заставить NFT отвергать (или снова принимать) переводы.
    async sendSetReject(provider: ContractProvider, via: Sender, value: bigint, reject: boolean) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x0badc0de, 32).storeBit(reject).endCell(),
        });
    }

    // ТОЛЬКО ДЛЯ ТЕСТОВ: NFT переводится, но не присылает excesses (нестандартное поведение).
    async sendSetSkipExcesses(provider: ContractProvider, via: Sender, value: bigint, skip: boolean) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x0badc0df, 32).storeBit(skip).endCell(),
        });
    }

    async getOwner(provider: ContractProvider): Promise<Address> {
        const { stack } = await provider.get('getOwner', []);
        return stack.readAddress();
    }
}
