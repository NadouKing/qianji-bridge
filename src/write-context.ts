import { AsyncLocalStorage } from "node:async_hooks";
export const writeObservation = new AsyncLocalStorage<{ sent: boolean }>();
export function noteRemoteWrite() { const current = writeObservation.getStore(); if (current) current.sent = true; }
