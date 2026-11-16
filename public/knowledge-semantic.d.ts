import type { SearchRecord } from './knowledge-contracts';
export const PROFILE: Readonly<{id:string; model:string; revision:string; dimensions:number; dtype:string; pooling:string;
  normalize:boolean; normalization:string; tokenLimit:number; manualTitleTokens:number; titleTokens:number; maxChunkChars:number; overlap:number; queryPrefix:string; structure?:string; maxInputChars?:number}>;
export const LEGACY_PROFILE: typeof PROFILE;
export interface SemanticChunk { readonly position:number; readonly manualId:string; readonly anchor?:string; readonly start:number; readonly end:number;
  readonly context:readonly string[]; readonly tokenCount:number; readonly text:string; readonly unitId?:string; readonly unitFingerprint?:string; readonly sourcePath?:string; readonly sourceAnchor?:string; readonly kind?:string; readonly section?:readonly string[]; readonly noteIds?:readonly string[]; readonly split?:boolean }
export interface SemanticIndex { readonly schema:1; readonly profile:typeof PROFILE; readonly chunks:readonly SemanticChunk[]; readonly vectors:string }
export function sourceText(value:unknown):string;
export function normalizeInput(text:string):string;
export function compatible(index:unknown):boolean;
export function chunksFor(records:readonly SearchRecord[], countTokens:(text:string)=>Promise<number>|number):Promise<SemanticChunk[]>;
export function createIndex(chunks:readonly SemanticChunk[], vectors:readonly number[][], profile?:typeof PROFILE):SemanticIndex;
export function validate(records:readonly SearchRecord[], index:SemanticIndex):Float32Array;

export function legacyChunksFor(records:readonly SearchRecord[], countTokens:(text:string)=>Promise<number>|number):Promise<SemanticChunk[]>;
