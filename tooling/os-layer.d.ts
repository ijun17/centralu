/** Types of tooling/os-layer.js, plain JavaScript so that eslint.config.js can import it */
export declare const OS_MODULES: readonly string[]
export declare function osModule(specifier: unknown): string | null
export declare const OS_LAYER: readonly string[]
export declare const PLATFORM_MODULES: readonly string[]
export declare function isChecked(file: string): boolean
export declare function isTestFile(file: string): boolean
export declare function inOsLayer(file: string): boolean
export declare const OS_ALLOWLIST: string
export declare function readOsAllowlist(root?: string): string[]
export declare function parseOsAllowlist(text: string): string[]
export declare function mayTouchOs(file: string, allowlist: ReadonlySet<string>): boolean
export declare const EVERY_OS_TESTS: ReadonlyArray<{ file: string; why: string }>
export declare const REPO_ROOT: string
