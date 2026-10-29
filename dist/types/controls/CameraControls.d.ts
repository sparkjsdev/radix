import * as THREE from "three";
export type CameraControlsMode = "fly" | "orbit";
export interface CameraControlsInertia {
    look: number;
    move: number;
    pointerLook: number;
    pointerMove: number;
}
export interface CameraControlsSettings {
    mode: CameraControlsMode;
    moveSpeed: number;
    lookSpeed: number;
    pointerLookSpeed: number;
    pointerPanSpeed: number;
    zoomSpeed: number;
    minDistance: number;
    maxDistance: number;
    fastMultiplier: number;
    slowMultiplier: number;
    capsMultiplier: number;
    invertLookX: boolean;
    invertLookY: boolean;
    invertPan: boolean;
    invertZoom: boolean;
    invertStickY: boolean;
    pointerLock: boolean;
    inertia: CameraControlsInertia;
    modeKey: string;
    doublePress: number;
    stickDeadZone: number;
    xrMoveSpeed: number;
    xrTurnSpeed: number;
}
export interface XrInput {
    isPresenting: boolean;
    getSession(): XRSession | null;
}
export declare class CameraControls {
    static readonly DEFAULTS: CameraControlsSettings;
    readonly canvas: HTMLCanvasElement;
    object: THREE.Object3D;
    settings: CameraControlsSettings;
    distance: number;
    enabled: boolean;
    onChange?: (settings: CameraControlsSettings) => void;
    xr?: XrInput;
    rig?: THREE.Object3D;
    pick?: (x: number, y: number) => Promise<THREE.Vector3 | undefined>;
    readonly storageKey?: string;
    private pageDefaults;
    private pivot?;
    private pivotLook;
    private pivotDrag;
    private pointers;
    private lastPress;
    private keys;
    private capsLock;
    private look;
    private pan;
    private zoom;
    private keyLookVelocity;
    private keyMoveVelocity;
    private pointerLookVelocity;
    private pointerPanVelocity;
    private dragStart;
    private dragMoves;
    private lastTime?;
    private abort;
    constructor({ canvas, object, settings, storageKey, xr, rig }: {
        canvas: HTMLCanvasElement;
        object: THREE.Object3D;
        settings?: Partial<CameraControlsSettings>;
        storageKey?: string;
        xr?: XrInput;
        rig?: THREE.Object3D;
    });
    dispose(): void;
    get mode(): CameraControlsMode;
    set mode(mode: CameraControlsMode);
    set(settings: Partial<CameraControlsSettings>): void;
    save({ personal }?: {
        personal?: boolean;
    }): void;
    reset({ personal }?: {
        personal?: boolean;
    }): void;
    getTarget(out?: THREE.Vector3): THREE.Vector3;
    lookAt(target: THREE.Vector3): void;
    update(): boolean;
    private clearInput;
    private locked;
    private pointerDown;
    private pointerMove;
    private applyMove;
    private drag;
    private pointerUp;
    private keyDown;
    private updateXr;
}
