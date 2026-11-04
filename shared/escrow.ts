import { id, type Signer, type TypedDataDomain } from 'ethers';

export const ESCROW_CHAIN_ID = 10143;
export const ESCROW_DOMAIN_NAME = 'PerpduelRoomEscrow';
export const ESCROW_DOMAIN_VERSION = '1';
export const ESCROW_ABI = [
  'constructor(address signer)',
  'function CHAIN_ID() view returns (uint256)',
  'function MIN_REFUND_DELAY() view returns (uint256)',
  'function MAX_REFUND_DELAY() view returns (uint256)',
  'function resultSigner() view returns (address)',
  'function getRoom(bytes32 roomId) view returns (address creator,address opponent,uint256 stake,uint64 refundAfter,uint8 status)',
  'function credits(address wallet) view returns (uint256)',
  'function createRoom(bytes32 roomId,uint64 refundAfter) payable',
  'function joinRoom(bytes32 roomId) payable',
  'function resolve(bytes32 roomId,address winner,uint64 deadline,bytes signature)',
  'function withdraw()',
  'function cancelUnjoined(bytes32 roomId)',
  'function refundExpired(bytes32 roomId)',
  'event RoomCreated(bytes32 indexed roomId,address indexed creator,uint256 stake,uint64 refundAfter)',
  'event RoomJoined(bytes32 indexed roomId,address indexed opponent)',
  'event RoomResolved(bytes32 indexed roomId,address indexed winner,uint256 pool)',
  'event RoomRefunded(bytes32 indexed roomId)',
  'event Withdrawal(address indexed wallet,uint256 amount)',
] as const;
export const RESOLVE_TYPES = {
  Resolve: [
    { name: 'roomId', type: 'bytes32' },
    { name: 'winner', type: 'address' },
    { name: 'deadline', type: 'uint64' },
  ],
};
export type Resolution = { roomId: string; winner: string; deadline: number };
export const roomKey = (roomId: string) => id(roomId);
export function escrowDomain(contractAddress: string): TypedDataDomain {
  return { name: ESCROW_DOMAIN_NAME, version: ESCROW_DOMAIN_VERSION, chainId: ESCROW_CHAIN_ID, verifyingContract: contractAddress };
}
export async function signResolution(signer: Signer, contractAddress: string, resolution: Resolution): Promise<string> {
  return signer.signTypedData(escrowDomain(contractAddress), RESOLVE_TYPES, resolution);
}
