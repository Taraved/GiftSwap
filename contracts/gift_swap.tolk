// GiftSwap: эскроу-контракт для продажи ОДНОГО NFT за TON.
//
// Сценарий:
//   1. Продавец деплоит контракт: указывает адрес NFT и цену.       (WaitingNft)
//   2. Продавец переводит NFT на адрес контракта (forward_amount > 0!).
//      NFT-контракт присылает уведомление OwnershipAssigned.        (ForSale)
//   3. Покупатель шлёт сообщение Buy с TON. Контракт ДЕРЖИТ деньги
//      у себя и просит NFT перевестись покупателю.                  (Transferring)
//   4a. NFT подтвердил перевод сообщением Excesses: платим продавцу,
//       возвращаем излишек покупателю.                              (Sold)
//   4b. NFT отказался переводиться (bounce): возвращаем деньги
//       покупателю, продажа снова открыта.                          (ForSale)
//   4c. NFT молчит (ни Excesses, ни bounce) дольше SETTLE_TIMEOUT: любой может
//       отправить Settle, и сделка завершается как успешная.        (Sold)
//   Если никто не купил, продавец может забрать NFT сообщением Cancel. (Cancelled)
//   Cancel работает и в WaitingNft: так можно вернуть NFT, отправленный без forward_amount
//   (состояние при этом не меняется). Остаток TON забирает сообщение Withdraw.
//
// query_id: каждый перевод NFT (при Buy и при Cancel) идёт с query_id, который выбирает САМ контракт
// (логическое время транзакции, оно уникально). Excesses и bounce принимаются только с этим query_id,
// поэтому чужое, старое или подделанное сообщение не может сойти за ответ на текущую покупку.

// ---------- Коды ошибок ----------
const ERR_NOT_EXPECTED_NFT = 101;   // сообщение пришло не от нашего NFT
const ERR_NOT_SELLER = 102;         // NFT прислал не продавец / Cancel не от продавца
const ERR_WRONG_STATE = 103;        // действие не подходит текущему состоянию
const ERR_WRONG_AMOUNT = 104;       // приложено слишком мало TON
const ERR_WRONG_QUERY_ID = 105;     // Excesses не относится к текущему переводу NFT
const ERR_TOO_EARLY = 106;          // Settle раньше срока
const ERR_NOTHING_TO_WITHDRAW = 107; // Withdraw, когда сверх резерва выводить нечего
const ERR_UNKNOWN_OP = 0xFFFF;      // непонятное сообщение

// ---------- Деньги ----------
// Числа подобраны замерами в Sandbox (tests/GiftSwapWithNft.spec.ts, раздел «газ и константы»).
// Референсный NFT (TEP-62) всегда оставляет себе 0.05 TON и возвращает остальное как excesses,
// поэтому нужный ему минимум крошечный (~0.0003 TON у NFT с обычным балансом). Мы прикладываем
// 0.05 с большим запасом на NFT с малым балансом; всё неиспользованное вернётся покупателю.
const NFT_TRANSFER_MIN = ton("0.05");
// Запас контракта на газ и комиссии. Замер: обработчик стоит до 0.0004 TON, вся продажа ~0.0008 TON.
const GAS_RESERVE = ton("0.01");
// Сколько остаётся на контракте после Withdraw. Плата за хранение за 10 лет ~0.014 TON (растёт с размером
// кода и данных, поэтому её надо перемерять при каждой заметной правке контракта), значит, 0.02 хватает лет на 14.
const WITHDRAW_KEEP = ton("0.02");
// Меньший остаток сверх WITHDRAW_KEEP Withdraw не выводит (ERR_NOTHING_TO_WITHDRAW): вывод «пыли»
// стоил бы продавцу больше, чем он получит.
const WITHDRAW_MIN = ton("0.005");

// ---------- Время ----------
// Через сколько секунд после Buy можно вызвать Settle. Перевод NFT отправлен с bounce, поэтому при провале
// ответ (bounce) обычно приходит за секунды. Но при сильной перегрузке сети сообщения могут часами стоять
// в очередях, а Settle, вызванный раньше bounce, заплатил бы продавцу за непереданный NFT. Поэтому срок
// берём с большим запасом: сутки. Обычному NFT Settle не нужен вовсе: по TEP-62 он всегда присылает Excesses.
const SETTLE_TIMEOUT = 24 * 3600;

// Код операции перевода NFT (TEP-62). Нужен и здесь, чтобы узнать наш перевод в теле bounce.
const OP_NFT_TRANSFER = 0x5fcc3d14;

// ---------- Состояние ----------
enum State: uint8 {
    WaitingNft      // ждём, пока продавец переведёт NFT
    ForSale         // NFT у нас, можно покупать
    Transferring    // покупатель заплатил, ждём подтверждения перевода NFT
    Sold            // продано
    Cancelled       // продавец забрал NFT обратно
}

// Данные текущей покупки. Лежат в отдельной ячейке-ссылке, иначе Storage не влезает в 1023 бита.
struct Purchase {
    buyer: address
    paid: coins         // сколько покупатель приложил к Buy
    startedAt: uint32   // unixtime, когда пришёл Buy (для Settle)
}

struct Storage {
    state: State
    seller: address
    nftAddress: address
    price: coins
    pendingQueryId: uint64      // query_id последнего перевода NFT, ответ на который мы ждём (0 = такого нет)
    purchase: Cell<Purchase>?   // заполнено только в Transferring
}

// То, что возвращает get-метод (плоский вид, удобно читать из обёртки).
struct SwapInfo {
    state: State
    seller: address
    nftAddress: address
    price: coins
    buyer: address?
    paid: coins
    queryId: uint64         // pendingQueryId
    settleAfter: uint32     // с какого unixtime работает Settle (0, если покупки нет)
}

fun Storage.load() {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

// ---------- Входящие сообщения ----------
// TEP-62: NFT-контракт присылает это новому владельцу после перевода.
struct (0x05138d91) OwnershipAssigned {
    queryId: uint64
    prevOwner: address
    forwardPayload: RemainingBitsAndRefs
}

// TEP-62: NFT шлёт это на response_destination после УСПЕШНОГО перевода.
// Для нас это подтверждение, что NFT ушёл к покупателю.
struct (0xd53276db) Excesses {
    queryId: uint64
}

// Сообщения от пользователей не несут query_id: его выбирает контракт.
struct (0x0b5a0001) Buy {}

struct (0x0b5a0002) Cancel {}

struct (0x0b5a0003) Withdraw {}

struct (0x0b5a0004) Settle {}

type AllowedMessage = OwnershipAssigned | Excesses | Buy | Cancel | Withdraw | Settle

// ---------- Исходящее сообщение ----------
// TEP-62: просьба к NFT-контракту передать себя новому владельцу.
struct (0x5fcc3d14) NftTransfer {
    queryId: uint64
    newOwner: address
    responseDestination: address    // кому вернуть излишек TON (и Excesses)
    customPayload: cell?
    forwardAmount: coins
    forwardPayload: bool            // false = один бит 0 = "пустой inline payload"
}

fun sendNft(
    nftAddress: address,
    newOwner: address,
    responseDestination: address,
    value: coins,
    queryId: uint64,
    bounce: BounceMode,
) {
    val msg = createMessage({
        bounce: bounce,
        dest: nftAddress,
        value: value,
        body: NftTransfer {
            queryId: queryId,
            newOwner: newOwner,
            responseDestination: responseDestination,
            customPayload: null,
            forwardAmount: 0,
            forwardPayload: false,
        },
    });
    msg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun sendTon(dest: address, value: coins) {
    val msg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: dest,
        value: value,
    });
    msg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

// ---------- Завершение и откат покупки (общие для Excesses/Settle и для bounce) ----------
// Сделка состоялась: продавцу цена, покупателю возврат.
// `returned` — сколько TON NFT вернул из наших NFT_TRANSFER_MIN (при Settle это 0: ответа не было).
fun Storage.completeSale(mutate self, returned: coins) {
    val purchase = self.purchase!.load();
    val seller = self.seller;
    val price = self.price;
    // Возврат покупателю = приложено - цена - (NFT_TRANSFER_MIN + GAS_RESERVE) + то, что NFT вернул.
    // Так покупатель платит только реальные расходы NFT и наш запас, а не все 0.05.
    // Засчитываем не больше NFT_TRANSFER_MIN: если NFT вернул больше, это его собственные TON,
    // они остаются на контракте и достанутся продавцу через Withdraw.
    // Результат никогда не отрицателен: handleBuy гарантирует paid >= price + NFT_TRANSFER_MIN + GAS_RESERVE.
    val returnedToBuyer = min(returned, NFT_TRANSFER_MIN);
    val surplus = purchase.paid - price - NFT_TRANSFER_MIN - GAS_RESERVE + returnedToBuyer;

    // Сначала меняем состояние, потом отправляем деньги.
    self.state = State.Sold;
    self.purchase = null;
    self.pendingQueryId = 0;
    self.save();

    sendTon(seller, price);
    if (surplus > 0) {
        sendTon(purchase.buyer, surplus);
    }
}

// Перевод NFT не удался: покупателю деньги назад (минус запас), продажа снова открыта.
fun Storage.reopenSale(mutate self) {
    val purchase = self.purchase!.load();

    self.state = State.ForSale;
    self.purchase = null;
    self.pendingQueryId = 0;
    self.save();

    sendTon(purchase.buyer, purchase.paid - GAS_RESERVE);
}

// ---------- Обработчики ----------
fun handleOwnershipAssigned(sender: address, msg: OwnershipAssigned) {
    var storage = Storage.load();

    // Защита от подделки: уведомление принимаем только от адреса нашего NFT.
    // Любой может отправить сообщение с таким же кодом операции, но не с чужого адреса.
    assert (sender == storage.nftAddress) throw ERR_NOT_EXPECTED_NFT;
    // Защита от повторного депозита.
    assert (storage.state == State.WaitingNft) throw ERR_WRONG_STATE;
    // Раз отправитель — наш NFT, prevOwner можно доверять: это тот, кто перевёл NFT.
    assert (msg.prevOwner == storage.seller) throw ERR_NOT_SELLER;

    storage.state = State.ForSale;
    storage.save();
}

fun handleBuy(sender: address, value: coins) {
    var storage = Storage.load();

    // Защита от повторной покупки (и от покупки до депозита NFT, и во время другой покупки).
    assert (storage.state == State.ForSale) throw ERR_WRONG_STATE;
    // Защита от неверной суммы: цена + минимум на перевод NFT + запас на газ.
    assert (value >= storage.price + NFT_TRANSFER_MIN + GAS_RESERVE) throw ERR_WRONG_AMOUNT;

    // query_id выбираем сами: логическое время этой транзакции уникально и покупателю неизвестно заранее.
    // По нему мы потом узнаем ответ (Excesses или bounce) именно на этот перевод.
    val queryId = blockchain.logicalTime();

    // Запоминаем покупателя и сумму: они понадобятся и при успехе, и при возврате.
    storage.state = State.Transferring;
    storage.pendingQueryId = queryId;
    storage.purchase = Purchase { buyer: sender, paid: value, startedAt: blockchain.now() }.toCell();
    storage.save();

    // Деньги остаются у нас. NFT — покупателю, а подтверждение (Excesses) вернётся к нам.
    // Bounce включён: если NFT не сможет выполнить перевод, мы узнаем в onBouncedMessage.
    sendNft(
        storage.nftAddress,
        sender,
        contract.getAddress(),
        NFT_TRANSFER_MIN,
        queryId,
        BounceMode.Only256BitsOfBody,
    );
}

// NFT подтвердил, что перевод выполнен. `returned` — сколько TON он вернул из наших NFT_TRANSFER_MIN.
fun handleExcesses(sender: address, returned: coins, msg: Excesses) {
    var storage = Storage.load();

    // Только наш NFT может подтвердить перевод (иначе любой заставил бы нас заплатить продавцу).
    assert (sender == storage.nftAddress) throw ERR_NOT_EXPECTED_NFT;
    // Подтверждение имеет смысл только во время покупки (и только один раз).
    assert (storage.state == State.Transferring) throw ERR_WRONG_STATE;
    // И только для ТЕКУЩЕГО перевода: Excesses по другому переводу (например, по депозиту, у которого
    // продавец указал response_destination = наш адрес) подтверждением покупки не считается.
    assert (msg.queryId == storage.pendingQueryId) throw ERR_WRONG_QUERY_ID;

    storage.completeSale(returned);
}

// Выход из Transferring, если NFT ничего не ответил. Отправить может любой, но не раньше срока.
fun handleSettle() {
    var storage = Storage.load();

    assert (storage.state == State.Transferring) throw ERR_WRONG_STATE;
    val purchase = storage.purchase!.load();
    assert (blockchain.now() >= purchase.startedAt + SETTLE_TIMEOUT) throw ERR_TOO_EARLY;

    // Перевод шёл с bounce: провал дал бы bounce за секунды. Долгая тишина значит, что NFT перевёлся.
    // Возврата от NFT мы не видели, поэтому в возврат покупателю его не засчитываем.
    storage.completeSale(0);
}

fun handleCancel(sender: address, value: coins) {
    var storage = Storage.load();

    assert (sender == storage.seller) throw ERR_NOT_SELLER;
    // ForSale: отменяем продажу. WaitingNft: возвращаем NFT, который мог прийти без уведомления.
    assert (storage.state == State.ForSale || storage.state == State.WaitingNft) throw ERR_WRONG_STATE;
    assert (value >= NFT_TRANSFER_MIN + GAS_RESERVE) throw ERR_WRONG_AMOUNT;

    // Свой query_id и здесь: так опоздавший bounce от этого Cancel не спутается с ответом на покупку.
    val queryId = blockchain.logicalTime();

    // В WaitingNft сделка ещё не началась, состояние не трогаем: продавец сможет отправить NFT заново.
    if (storage.state == State.ForSale) {
        storage.state = State.Cancelled;
    }
    storage.pendingQueryId = queryId;
    storage.save();

    // Bounce включён: если NFT не вернётся, onBouncedMessage вернёт нам возможность повторить.
    sendNft(
        storage.nftAddress,
        storage.seller,
        storage.seller,
        value - GAS_RESERVE,
        queryId,
        BounceMode.Only256BitsOfBody,
    );
}

// Продавец забирает TON, оставшиеся на контракте (остатки депозитов, «пыль»).
// Разрешено только там, где в контракте нет чужих денег: не в ForSale (там лежит NFT
// и идёт отмена) и не в Transferring (там лежат деньги покупателя).
fun handleWithdraw(sender: address, value: coins) {
    val storage = Storage.load();

    assert (sender == storage.seller) throw ERR_NOT_SELLER;
    assert (
        storage.state == State.WaitingNft
        || storage.state == State.Sold
        || storage.state == State.Cancelled
    ) throw ERR_WRONG_STATE;
    // Баланс на начало вычислений уже включает TON этого сообщения; вычитаем их, чтобы увидеть,
    // сколько лежало на контракте до Withdraw. Если сверх резерва почти ничего, отказываем:
    // bounce вернёт продавцу приложенные TON, а пустой вывод не потратит комиссию впустую.
    val balanceBefore = contract.getOriginalBalance() - value;
    assert (balanceBefore > WITHDRAW_KEEP + WITHDRAW_MIN) throw ERR_NOTHING_TO_WITHDRAW;

    // Оставляем резерв на плату за хранение, всё остальное отправляем продавцу.
    reserveGramsOnBalance(WITHDRAW_KEEP, RESERVE_MODE_EXACT_AMOUNT);
    val msg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: storage.seller,
        value: 0,
    });
    msg.send(SEND_MODE_CARRY_ALL_BALANCE);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    match (msg) {
        OwnershipAssigned => handleOwnershipAssigned(in.senderAddress, msg),
        Excesses => handleExcesses(in.senderAddress, in.valueCoins, msg),
        Buy => handleBuy(in.senderAddress, in.valueCoins),
        Cancel => handleCancel(in.senderAddress, in.valueCoins),
        Withdraw => handleWithdraw(in.senderAddress, in.valueCoins),
        Settle => handleSettle(),
        else => {
            // Пустое сообщение — просто пополнение баланса, остальное отвергаем.
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP;
        }
    }
}

// Сюда приходит наше сообщение, если получатель не смог его обработать.
// С bounce мы отправляем только переводы NFT (в handleBuy и handleCancel).
fun onBouncedMessage(in: InMessageBounced) {
    var storage = Storage.load();

    // Ничего не ломаем, если это не то, что мы ждём: возвращённые TON просто остаются на контракте.
    if (in.senderAddress != storage.nftAddress) {
        return;
    }

    // Тело bounce: 0xFFFFFFFF + начало исходного сообщения. У нашего перевода это код операции и query_id.
    var body = in.bouncedBody;
    body.skipBouncedPrefix();
    val op = body.loadUint(32);
    val queryId = body.loadUint(64);

    // Принимаем bounce только от нашего ТЕКУЩЕГО перевода. Опоздавший bounce от старого перевода
    // (например, от Cancel, отправленного в WaitingNft) с другим query_id игнорируется.
    if (storage.pendingQueryId == 0 || op != OP_NFT_TRANSFER || queryId != storage.pendingQueryId) {
        return;
    }

    if (storage.state == State.Transferring) {
        // Не удался перевод NFT покупателю: возвращаем деньги, продажа снова открыта.
        storage.reopenSale();
    } else if (storage.state == State.Cancelled) {
        // Не удался возврат NFT продавцу: NFT всё ещё у нас, даём продавцу повторить Cancel.
        storage.state = State.ForSale;
        storage.pendingQueryId = 0;
        storage.save();
    } else {
        // Например, неудачный Cancel в WaitingNft: менять нечего, просто забываем этот query_id.
        storage.pendingQueryId = 0;
        storage.save();
    }
}

// ---------- Get-метод ----------
// Возвращает: state, seller, nftAddress, price, buyer (или null), paid, queryId, settleAfter.
get fun swapInfo(): SwapInfo {
    val storage = Storage.load();
    var buyer: address? = null;
    var paid: coins = 0;
    var settleAfter = 0;
    val current = storage.purchase;
    if (current != null) {
        val purchase = current.load();
        buyer = purchase.buyer;
        paid = purchase.paid;
        settleAfter = purchase.startedAt + SETTLE_TIMEOUT;
    }
    return {
        state: storage.state,
        seller: storage.seller,
        nftAddress: storage.nftAddress,
        price: storage.price,
        buyer: buyer,
        paid: paid,
        queryId: storage.pendingQueryId,
        settleAfter: settleAfter,
    };
}
