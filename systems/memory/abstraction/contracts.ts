#!/usr/bin/env node
'use strict';
export {};

export type MemoryViewResult = {
  ok: boolean,
  status: number,
  stdout: string,
  stderr: string
};

export interface MemoryView {
  query(args?: string[]): MemoryViewResult;
  get(args?: string[]): MemoryViewResult;
  snapshot(args?: string[]): MemoryViewResult;
  status(args?: string[]): MemoryViewResult;
}

export interface AnalyticsEngine {
  run(args?: string[]): MemoryViewResult;
  baselineCapture(args?: string[]): MemoryViewResult;
  status(args?: string[]): MemoryViewResult;
}

export interface TestHarness {
  run(args?: string[]): MemoryViewResult;
  baselineCapture(args?: string[]): MemoryViewResult;
  status(args?: string[]): MemoryViewResult;
}
