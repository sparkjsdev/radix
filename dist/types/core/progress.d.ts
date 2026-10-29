export type ProgressStage = "downloading" | "decoding" | "encoding" | "compressing";
export type Progress = (fraction: number, stage: ProgressStage) => void;
export declare function span(progress: Progress | undefined, from: number, to: number): Progress | undefined;
export declare function counter(progress: Progress | undefined, total: number, stage: ProgressStage): (i: number) => false | void;
export declare function readResponse(response: Response, progress?: Progress): Promise<Uint8Array<ArrayBuffer>>;
