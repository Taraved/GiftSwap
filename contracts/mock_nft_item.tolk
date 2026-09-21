// MockNftItem: ТОЛЬКО ДЛЯ ТЕСТОВ. Упрощённый NFT по стандарту TEP-62:
// хранит владельца и умеет transfer -> ownership_assigned + excesses.
// Правило достаточности TON скопировано из референсной реализации (баланс - 0.05 - комиссии >= 0).
// Нужен, чтобы проверять GiftSwap против настоящих сообщений, а не против кошелька-заглушки.
// Не деплоить на mainnet и не использовать как образец полноценного NFT.

const ERR_NOT_OWNER = 401;          // как в референсной реализации TEP-62
const ERR_NOT_ENOUGH_VALUE = 402;   // приложено слишком мало TON
const ERR_TRANSFERS_REJECTED = 403; // тестовый переключатель: NFT отказывается переводиться
const ERR_UNKNOWN_OP = 0xFFFF;

// Как min_tons_for_storage() в референсном nft-item.fc (ton-blockchain/token-contract):
// NFT всегда оставляет себе 0.05 TON, а всё, что сверх этого, возвращает как excesses.
const MIN_TONS_FOR_STORAGE = ton("0.05");

struct Storage {
    owner: address
    rejectTransfers: bool   // тестовый переключатель, чтобы заставить transfer падать
}

fun Storage.load() {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

// transfer#5fcc3d14 из TEP-62
struct (0x5fcc3d14) Transfer {
    queryId: uint64
    newOwner: address
    responseDestination: address
    customPayload: cell?
    forwardAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

// ownership_assigned#05138d91 из TEP-62
struct (0x05138d91) OwnershipAssigned {
    queryId: uint64
    prevOwner: address
    forwardPayload: RemainingBitsAndRefs
}

// excesses#d53276db из TEP-62
struct (0xd53276db) Excesses {
    queryId: uint64
}

// ТОЛЬКО ДЛЯ ТЕСТОВ: включает/выключает отказ от переводов (в настоящем NFT такого нет).
struct (0x0badc0de) SetReject {
    reject: bool
}

type AllowedMessage = Transfer | SetReject

fun handleTransfer(sender: address, forwardFee: coins, msg: Transfer) {
    var storage = Storage.load();

    assert (!storage.rejectTransfers) throw ERR_TRANSFERS_REJECTED;
    assert (sender == storage.owner) throw ERR_NOT_OWNER;

    // Правило из референса: решает БАЛАНС NFT (он уже включает пришедшие TON), а не сумма сообщения.
    // rest_amount = баланс - 0.05 - (forward_amount + fee, если есть уведомление) - fee (на excesses).
    val fee = forwardFee * 3 / 2;
    var rest = contract.getOriginalBalance() - MIN_TONS_FOR_STORAGE;
    if (msg.forwardAmount > 0) {
        rest -= msg.forwardAmount + fee;
    }
    rest -= fee;
    assert (rest >= 0) throw ERR_NOT_ENOUGH_VALUE;

    val prevOwner = storage.owner;
    storage.owner = msg.newOwner;
    storage.save();

    if (msg.forwardAmount > 0) {
        val notification = createMessage({
            bounce: BounceMode.NoBounce,
            dest: msg.newOwner,
            value: msg.forwardAmount,
            body: UnsafeBodyNoRef {
                forceInline: OwnershipAssigned {
                    queryId: msg.queryId,
                    prevOwner: prevOwner,
                    forwardPayload: msg.forwardPayload,
                },
            },
        });
        notification.send(SEND_MODE_PAY_FEES_SEPARATELY);
    }

    val excess = createMessage({
        bounce: BounceMode.NoBounce,
        dest: msg.responseDestination,
        value: rest,
        body: Excesses { queryId: msg.queryId },
    });
    excess.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun handleSetReject(msg: SetReject) {
    var storage = Storage.load();
    storage.rejectTransfers = msg.reject;
    storage.save();
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    match (msg) {
        Transfer => handleTransfer(in.senderAddress, in.originalForwardFee, msg),
        SetReject => handleSetReject(msg),
        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP;
        }
    }
}

get fun getOwner(): address {
    return Storage.load().owner;
}
