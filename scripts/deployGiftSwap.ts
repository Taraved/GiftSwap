import { Address, toNano } from '@ton/core';
import { GiftSwap } from '../wrappers/GiftSwap';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    // Продавец — тот, кто запускает скрипт.
    const seller = provider.sender().address!;
    const nftAddress = Address.parse(await ui.input('Адрес NFT, который продаём:'));
    const price = toNano(await ui.input('Цена в TON (например 1.5):'));

    const giftSwap = provider.open(
        GiftSwap.createFromConfig({ seller, nftAddress, price }, await compile('GiftSwap')),
    );

    await giftSwap.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(giftSwap.address);

    ui.write(`Контракт: ${giftSwap.address}`);
    ui.write('Теперь переведи NFT на адрес контракта, чтобы выставить его на продажу.');
    // Замер: уведомлению нужно минимум ~0.00014 TON. Без forward_amount уведомления не будет вовсе.
    ui.write('При переводе укажи forward_amount не меньше 0.01 TON, иначе контракт не узнает о депозите.');
}
