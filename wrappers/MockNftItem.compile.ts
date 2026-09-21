import { CompilerConfig } from '@ton/blueprint';

// Тестовый NFT, см. contracts/mock_nft_item.tolk
export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/mock_nft_item.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
