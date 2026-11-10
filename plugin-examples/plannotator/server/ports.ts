import type { VcsResolvedComparison } from "@getpaseo/plugin";
import type {
  Prepared,
  Target,
  SourceSelection,
  FileEntry,
  ReviewState,
  Revision,
  Draft,
  GuideDocument,
} from "../shared/review";
import type { decision } from "./contract";
import type { z } from "zod";

export interface AgentInfo {
  cwd: string;
  name: string;
  busy: boolean;
}
export interface AgentConversation {
  inspect(target: Target): Promise<AgentInfo>;
  send(target: Target, text: string, messageId: string): Promise<void>;
}
export interface SourceSnapshot {
  resolved: VcsResolvedComparison;
  patch: string;
  files: FileEntry[];
}
export interface ReviewSource {
  prepare(target: Target, selection: SourceSelection): Promise<Prepared>;
  snapshot(target: Target, selection: SourceSelection): Promise<SourceSnapshot>;
}
export interface EngineGuide {
  id: string;
  document: GuideDocument;
  reviewed: boolean[];
}
export interface EngineState {
  draft: Draft | null;
  guides: EngineGuide[];
}
export interface EngineSession {
  url: string;
  result: Promise<z.infer<typeof decision> | null>;
  read(): Promise<EngineState>;
  importGuide(document: GuideDocument): Promise<string>;
  stop(): Promise<void>;
}
export interface EngineOpen {
  cwd: string;
  revision: Revision;
  directory: string;
}
export interface ReviewEngine {
  open(input: EngineOpen): Promise<EngineSession>;
}
export interface ReviewStore {
  find(agentId: string): Promise<ReviewState | null>;
  save(state: ReviewState): Promise<void>;
  directory(reviewId: string, revisionId: string): string;
  patch(reviewId: string, revisionId: string, content: string): Promise<string>;
  request(
    reviewId: string,
    revisionId: string,
    requestId: string,
    content: string,
  ): Promise<{ input: string; output: string }>;
  readGuide(path: string): Promise<unknown | null>;
}
export interface ReviewPorts {
  source: ReviewSource;
  engine: ReviewEngine;
  conversation: AgentConversation;
  store: ReviewStore;
}
