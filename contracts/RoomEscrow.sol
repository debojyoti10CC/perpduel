// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Native MON room stakes on Monad testnet. The result signer is trusted
/// only to attest the paper-trading winner; it cannot withdraw anyone's credit.
contract RoomEscrow {
    uint256 public constant CHAIN_ID = 10143;
    uint256 public constant MIN_REFUND_DELAY = 120;
    uint256 public constant MAX_REFUND_DELAY = 7 days;
    address public immutable resultSigner;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RESOLVE_TYPEHASH = keccak256("Resolve(bytes32 roomId,address winner,uint64 deadline)");
    bytes32 private constant NAME_HASH = keccak256("PerpduelRoomEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // 0 absent, 1 open, 2 joined, 3 settled, 4 refunded/cancelled.
    struct Room { address creator; address opponent; uint256 stake; uint64 refundAfter; uint8 status; }
    mapping(bytes32 => Room) private rooms;
    mapping(address => uint256) public credits;
    uint256 private entered = 1;

    error WrongChain(); error InvalidSigner(); error InvalidRoom(); error InvalidStake();
    error InvalidExpiry(); error InvalidState(); error Unauthorized(); error Expired();
    error InvalidWinner(); error InvalidSignature(); error NothingToWithdraw();
    error TransferFailed(); error Reentrant(); error DirectTransfer();

    event RoomCreated(bytes32 indexed roomId, address indexed creator, uint256 stake, uint64 refundAfter);
    event RoomJoined(bytes32 indexed roomId, address indexed opponent);
    event RoomResolved(bytes32 indexed roomId, address indexed winner, uint256 pool);
    event RoomRefunded(bytes32 indexed roomId);
    event Withdrawal(address indexed wallet, uint256 amount);

    constructor(address signer) {
        if (block.chainid != CHAIN_ID) revert WrongChain();
        if (signer == address(0)) revert InvalidSigner();
        resultSigner = signer;
    }

    function getRoom(bytes32 roomId) external view returns (address creator, address opponent, uint256 stake, uint64 refundAfter, uint8 status) {
        Room storage room = rooms[roomId];
        return (room.creator, room.opponent, room.stake, room.refundAfter, room.status);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function createRoom(bytes32 roomId, uint64 refundAfter) external payable {
        if (roomId == bytes32(0) || rooms[roomId].status != 0) revert InvalidRoom();
        if (msg.value == 0 || msg.value > type(uint256).max / 2) revert InvalidStake();
        if (refundAfter < block.timestamp + MIN_REFUND_DELAY || refundAfter > block.timestamp + MAX_REFUND_DELAY) revert InvalidExpiry();
        rooms[roomId] = Room(msg.sender, address(0), msg.value, refundAfter, 1);
        emit RoomCreated(roomId, msg.sender, msg.value, refundAfter);
    }

    function joinRoom(bytes32 roomId) external payable {
        Room storage room = rooms[roomId];
        if (room.status != 1) revert InvalidState();
        if (block.timestamp >= room.refundAfter) revert Expired();
        if (msg.sender == room.creator) revert Unauthorized();
        if (msg.value != room.stake) revert InvalidStake();
        room.opponent = msg.sender;
        room.status = 2;
        emit RoomJoined(roomId, msg.sender);
    }

    function resolve(bytes32 roomId, address winner, uint64 deadline, bytes calldata signature) external {
        Room storage room = rooms[roomId];
        if (room.status != 2) revert InvalidState();
        if (block.timestamp >= room.refundAfter || block.timestamp > deadline) revert Expired();
        if (deadline > room.refundAfter) revert InvalidExpiry();
        if (winner != address(0) && winner != room.creator && winner != room.opponent) revert InvalidWinner();
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(RESOLVE_TYPEHASH, roomId, winner, deadline))));
        if (ecrecover(digest, v, r, s) != resultSigner) revert InvalidSignature();
        room.status = 3;
        uint256 pool = room.stake * 2;
        if (winner == address(0)) {
            credits[room.creator] += room.stake;
            credits[room.opponent] += room.stake;
        } else {
            credits[winner] += pool;
        }
        emit RoomResolved(roomId, winner, pool);
    }

    function cancelUnjoined(bytes32 roomId) external {
        Room storage room = rooms[roomId];
        if (room.status != 1) revert InvalidState();
        if (msg.sender != room.creator) revert Unauthorized();
        room.status = 4;
        credits[room.creator] += room.stake;
        emit RoomRefunded(roomId);
    }

    function refundExpired(bytes32 roomId) external {
        Room storage room = rooms[roomId];
        if (room.status != 1 && room.status != 2) revert InvalidState();
        if (block.timestamp < room.refundAfter) revert InvalidExpiry();
        room.status = 4;
        credits[room.creator] += room.stake;
        if (room.opponent != address(0)) credits[room.opponent] += room.stake;
        emit RoomRefunded(roomId);
    }

    function withdraw() external {
        if (entered != 1) revert Reentrant();
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        entered = 2;
        credits[msg.sender] = 0;
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        entered = 1;
        emit Withdrawal(msg.sender, amount);
    }

    receive() external payable { revert DirectTransfer(); }
}
