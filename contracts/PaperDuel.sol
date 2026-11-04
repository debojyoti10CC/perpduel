// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Relayer-priced, virtual-money trading contests. No deposits or withdrawable assets.
/// @dev The relayer is TRUSTED for quote authenticity and drawdown sampling. No oracle proof is claimed.
contract PaperDuel {
    uint256 public constant USD = 1e8;
    uint256 public constant QTY = 1e18;
    uint256 public constant INITIAL = 1000 * USD;
    uint256 public constant RISK_FLOOR = 200 * USD;
    address public immutable relayer;

    struct Quote { uint256 mark; uint256 bid; uint256 ask; uint64 time; }
    struct Position { int256 quantity; uint256 entry; uint256 margin; }
    struct Account { int256 cash; int256 realizedPnl; uint256 fees; uint256 peakEquity; uint256 maxDrawdown; bool disabled; uint64 nonce; Position[6] positions; }
    struct AccountView { int256 cash; int256 realizedPnl; uint256 fees; uint256 equity; int256 unrealizedPnl; uint256 reservedMargin; uint256 availableMargin; uint256 peakEquity; uint256 maxDrawdown; int256 score; bool disabled; uint64 nonce; }
    struct Duel { uint64 startAt; uint64 endAt; uint8 status; int8 winner; Quote[6] quotes; Account[2] accounts; }
    mapping(bytes32 => Duel) private duels;

    event Created(bytes32 indexed id, uint64 startAt, uint64 endAt);
    event Traded(bytes32 indexed id, uint8 indexed seat, uint8 indexed market, uint8 action, int256 quantity, uint256 price, uint256 fee, uint64 nonce);
    event RiskClosed(bytes32 indexed id, uint8 indexed seat, uint256 equity);
    event Settled(bytes32 indexed id, int8 winner, int256 score0, int256 score1);
    event Voided(bytes32 indexed id);
    error Unauthorized(); error InvalidMatch(); error InvalidClock(); error NotActive(); error StaleQuote(); error InvalidQuote(); error InvalidNonce(); error Disabled(); error InsufficientMargin(); error NoPosition(); error InvalidOrder();

    constructor(address operator) { if (operator == address(0)) revert Unauthorized(); relayer = operator; }
    modifier onlyRelayer() { if (msg.sender != relayer) revert Unauthorized(); _; }

    function create(bytes32 id, uint64 startAt, uint64 endAt) external onlyRelayer {
        if (duels[id].status != 0) revert InvalidMatch();
        if (startAt < block.timestamp || endAt <= startAt || endAt - startAt > 3600) revert InvalidClock();
        Duel storage d = duels[id]; d.startAt = startAt; d.endAt = endAt; d.status = 1; d.winner = -1;
        for (uint8 s; s < 2; s++) { d.accounts[s].cash = int256(INITIAL); d.accounts[s].peakEquity = INITIAL; }
        emit Created(id, startAt, endAt);
    }

    function update(bytes32 id, Quote[6] calldata quotes) external onlyRelayer {
        Duel storage d = duels[id]; _active(d); _setQuotes(d, quotes, block.timestamp, false); _sampleBoth(id, d);
    }

    /// @param action 0 long, 1 short, 2 close half, 3 close all.
    function trade(bytes32 id, uint8 seat, uint8 market, uint8 action, uint256 margin, uint64 nonce, Quote[6] calldata quotes) external onlyRelayer {
        Duel storage d = duels[id]; _active(d);
        if (seat > 1 || market > 5 || action > 3) revert InvalidOrder();
        Account storage a = d.accounts[seat];
        if (a.disabled) revert Disabled();
        if (nonce != a.nonce + 1) revert InvalidNonce();
        _setQuotes(d, quotes, block.timestamp, false);
        _sampleBoth(id, d);
        a.nonce = nonce;
        // A risk-triggering price update is committed even when it disables this seat.
        if (a.disabled) return;
        Position storage p = a.positions[market];
        int256 signedQuantity; uint256 price; uint256 fee;
        if (action >= 2) {
            if (p.quantity == 0) revert NoPosition();
            uint256 quantity = _abs(p.quantity);
            if (action == 2) quantity /= 2;
            if (quantity == 0) revert NoPosition();
            (signedQuantity, price, fee) = _close(a, market, d.quotes[market], quantity);
        } else {
            if (margin != 100 * USD && margin != 250 * USD && margin != 500 * USD) revert InvalidOrder();
            bool buy = action == 0;
            // Reversal closes the full existing position atomically before the new order.
            if (p.quantity != 0 && ((p.quantity > 0) != buy)) {
                (int256 closedQuantity, uint256 closePrice, uint256 closeFee) = _close(a, market, d.quotes[market], _abs(p.quantity));
                emit Traded(id, seat, market, 3, closedQuantity, closePrice, closeFee, nonce);
                _sampleAccount(id, d, seat);
                if (a.disabled) return;
            }
            price = _execution(d.quotes[market], buy);
            uint256 notional = margin * 3;
            uint256 quantity = notional * QTY / price;
            if (quantity == 0) revert InvalidOrder();
            fee = quantity * price / QTY * 5 / 10000;
            AccountView memory beforeOrder = _accountView(d, a);
            // Include the immediately marked spread/slippage loss in the availability check.
            uint256 immediateLoss = buy ? (price > d.quotes[market].mark ? quantity * (price - d.quotes[market].mark) / QTY : 0) : (d.quotes[market].mark > price ? quantity * (d.quotes[market].mark - price) / QTY : 0);
            if (beforeOrder.availableMargin < margin + fee + immediateLoss) revert InsufficientMargin();
            uint256 oldQuantity = _abs(p.quantity);
            p.entry = (oldQuantity * p.entry + quantity * price) / (oldQuantity + quantity);
            signedQuantity = buy ? int256(quantity) : -int256(quantity);
            p.quantity += signedQuantity; p.margin += margin;
            a.cash -= int256(fee); a.fees += fee;
        }
        emit Traded(id, seat, market, action, signedQuantity, price, fee, nonce);
        _sampleAccount(id, d, seat);
    }

    function settle(bytes32 id, Quote[6] calldata quotes) external onlyRelayer {
        Duel storage d = duels[id];
        if (d.status != 1) revert InvalidMatch();
        if (block.timestamp < d.endAt) revert InvalidClock();
        // The immutable finish quote is at/before the shared deadline, fresh at that deadline.
        // A delayed receipt does not substitute later market prices.
        _setQuotes(d, quotes, d.endAt, true); _sampleBoth(id, d);
        for (uint8 s; s < 2; s++) {
            Account storage a = d.accounts[s];
            for (uint8 m; m < 6; m++) if (a.positions[m].quantity != 0) _close(a, m, d.quotes[m], _abs(a.positions[m].quantity));
            _track(a, _accountView(d, a).equity);
        }
        AccountView memory av0 = _accountView(d, d.accounts[0]); AccountView memory av1 = _accountView(d, d.accounts[1]);
        if (av0.score > av1.score) d.winner = 0;
        else if (av1.score > av0.score) d.winner = 1;
        else if (av0.maxDrawdown < av1.maxDrawdown) d.winner = 0;
        else if (av1.maxDrawdown < av0.maxDrawdown) d.winner = 1;
        else d.winner = -1;
        d.status = 2; emit Settled(id, d.winner, av0.score, av1.score);
    }

    function voidMatch(bytes32 id) external onlyRelayer { Duel storage d = duels[id]; if (d.status != 1) revert InvalidMatch(); d.status = 3; d.winner = -1; emit Voided(id); }

    function snapshot(bytes32 id) external view returns (AccountView[2] memory accounts, Position[6][2] memory positions, int8 winner, uint8 status) {
        Duel storage d = duels[id]; if (d.status == 0) revert InvalidMatch();
        for (uint8 s; s < 2; s++) { accounts[s] = _accountView(d, d.accounts[s]); positions[s] = d.accounts[s].positions; }
        return (accounts, positions, d.winner, d.status);
    }

    function _active(Duel storage d) private view { if (d.status != 1 || block.timestamp < d.startAt || block.timestamp >= d.endAt) revert NotActive(); }
    function _setQuotes(Duel storage d, Quote[6] calldata qs, uint256 referenceTime, bool finish) private {
        for (uint8 m; m < 6; m++) {
            Quote calldata q = qs[m];
            if (q.mark == 0 || q.bid == 0 || q.ask < q.bid || q.mark > 1e20 || q.ask > 1e20) revert InvalidQuote();
            uint256 referenceMs = referenceTime * 1000;
            // Block timestamps have second precision; allow millisecond quotes in that second.
            if (q.time > referenceMs + (finish ? 0 : 999) || uint256(q.time) + 5000 < referenceMs) revert StaleQuote();
            if (q.time < d.quotes[m].time) revert StaleQuote();
            d.quotes[m] = q;
        }
    }
    function _execution(Quote storage q, bool buy) private view returns (uint256) { return buy ? q.ask * 10001 / 10000 : q.bid * 9999 / 10000; }
    function _abs(int256 v) private pure returns (uint256) { return uint256(v < 0 ? -v : v); }
    function _close(Account storage a, uint8 m, Quote storage q, uint256 quantity) private returns (int256 signedQuantity, uint256 price, uint256 fee) {
        Position storage p = a.positions[m]; bool sell = p.quantity > 0;
        price = _execution(q, !sell); signedQuantity = sell ? -int256(quantity) : int256(quantity);
        int256 pnl = (sell ? int256(quantity) : -int256(quantity)) * (int256(price) - int256(p.entry)) / int256(QTY);
        fee = quantity * price / QTY * 5 / 10000;
        a.cash += pnl - int256(fee); a.realizedPnl += pnl; a.fees += fee;
        uint256 oldQuantity = _abs(p.quantity); p.margin -= p.margin * quantity / oldQuantity;
        p.quantity += signedQuantity;
        if (p.quantity == 0) { p.entry = 0; p.margin = 0; }
    }
    function _accountView(Duel storage d, Account storage a) private view returns (AccountView memory v) {
        v.cash = a.cash; v.realizedPnl = a.realizedPnl; v.fees = a.fees;
        for (uint8 m; m < 6; m++) { Position storage p = a.positions[m]; if (p.quantity != 0) { v.unrealizedPnl += p.quantity * (int256(d.quotes[m].mark) - int256(p.entry)) / int256(QTY); v.reservedMargin += p.margin; } }
        int256 marked = a.cash + v.unrealizedPnl; v.equity = marked > 0 ? uint256(marked) : 0;
        v.availableMargin = v.equity > v.reservedMargin ? v.equity - v.reservedMargin : 0;
        v.peakEquity = a.peakEquity; v.maxDrawdown = a.maxDrawdown;
        v.score = int256(v.equity) - int256(INITIAL) - int256(a.maxDrawdown * 35 / 100);
        v.disabled = a.disabled; v.nonce = a.nonce;
    }
    function _track(Account storage a, uint256 equity) private { if (equity > a.peakEquity) a.peakEquity = equity; uint256 dd = a.peakEquity - equity; if (dd > a.maxDrawdown) a.maxDrawdown = dd; }
    function _sampleAccount(bytes32 id, Duel storage d, uint8 s) private {
        Account storage a = d.accounts[s]; uint256 eq = _accountView(d, a).equity; _track(a, eq);
        if (!a.disabled && eq <= RISK_FLOOR) {
            a.disabled = true;
            for (uint8 m; m < 6; m++) if (a.positions[m].quantity != 0) _close(a, m, d.quotes[m], _abs(a.positions[m].quantity));
            eq = _accountView(d, a).equity; _track(a, eq); emit RiskClosed(id, s, eq);
        }
    }
    function _sampleBoth(bytes32 id, Duel storage d) private { for (uint8 s; s < 2; s++) _sampleAccount(id, d, s); }
}
