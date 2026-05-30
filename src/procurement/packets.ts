import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { structureProcurementRequest, type ProcurementStructure } from './structure.ts';

export type ProcurementPacketStatus =
  | 'submitted'
  | 'needs_review'
  | 'ready_for_sourcing'
  | 'approved'
  | 'changes_requested'
  | 'rejected';

export interface ProcurementPacketNote {
  id: string;
  actor: string;
  body: string;
  createdAt: string;
}

export interface ProcurementPacket {
  id: string;
  status: ProcurementPacketStatus;
  rawText: string;
  submittedBy: string;
  structure: ProcurementStructure;
  notes: ProcurementPacketNote[];
  createdAt: string;
  updatedAt: string;
}

interface PacketStore {
  packets: ProcurementPacket[];
}

const STATUSES = new Set<ProcurementPacketStatus>([
  'submitted',
  'needs_review',
  'ready_for_sourcing',
  'approved',
  'changes_requested',
  'rejected',
]);

export async function createProcurementPacket({
  rawText,
  submittedBy = 'inside_sales',
}: {
  rawText: string;
  submittedBy?: string;
}): Promise<ProcurementPacket> {
  const structure = await structureProcurementRequest(rawText);
  const now = new Date().toISOString();
  const packet: ProcurementPacket = {
    id: randomUUID(),
    status: structure.escalationRequired ? 'needs_review' : 'submitted',
    rawText,
    submittedBy,
    structure,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  const store = readPacketStore();
  store.packets.unshift(packet);
  writePacketStore(store);
  return packet;
}

export function listProcurementPackets(): ProcurementPacket[] {
  return readPacketStore().packets;
}

export function getProcurementPacket(id: string): ProcurementPacket | null {
  return readPacketStore().packets.find((packet) => packet.id === id) ?? null;
}

export function updateProcurementPacket(
  id: string,
  updates: {
    status?: string;
    note?: { actor?: string; body?: string };
  },
): ProcurementPacket | null {
  const store = readPacketStore();
  const packet = store.packets.find((item) => item.id === id);
  if (!packet) return null;

  if (updates.status) {
    if (!STATUSES.has(updates.status as ProcurementPacketStatus)) {
      throw new Error(`Unsupported procurement status: ${updates.status}`);
    }
    packet.status = updates.status as ProcurementPacketStatus;
  }

  const noteBody = updates.note?.body?.trim();
  if (noteBody) {
    packet.notes.unshift({
      id: randomUUID(),
      actor: updates.note?.actor?.trim() || 'inside_sales',
      body: noteBody,
      createdAt: new Date().toISOString(),
    });
  }

  packet.updatedAt = new Date().toISOString();
  writePacketStore(store);
  return packet;
}

function readPacketStore(): PacketStore {
  const path = packetStorePath();
  if (!existsSync(path)) return { packets: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PacketStore>;
  return {
    packets: Array.isArray(parsed.packets) ? parsed.packets : [],
  };
}

function writePacketStore(store: PacketStore): void {
  const path = packetStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  renameSync(tmpPath, path);
}

function packetStorePath(): string {
  if (config.PROCUREMENT_STORE_PATH) return resolve(config.PROCUREMENT_STORE_PATH);
  const brainStorePath = process.env.COMPANY_BRAIN_STORE_PATH;
  if (brainStorePath) return resolve(dirname(resolve(brainStorePath)), 'procurement-packets.json');
  return resolve(process.cwd(), '.company-brain-procurement.json');
}
