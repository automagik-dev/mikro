export interface CliFlagSchema {
    name: string;
    aliases?: string[];
    type: "boolean" | "string" | "number" | "list";
    default?: string | number | boolean | string[] | null;
    choices?: string[];
    description: string;
    appliesTo?: string[];
}
export interface ExitCodeSchema {
    code: number;
    meaning: string;
}
export interface JsonSchema {
    $schema?: string;
    type: string;
    description?: string;
    required?: string[];
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
}
export interface RlmxCliSchema {
    schemaVersion: 1;
    command: "rlmx";
    flags: CliFlagSchema[];
    output: JsonSchema;
    exitCodes: ExitCodeSchema[];
}
export declare const RLMX_CLI_SCHEMA: RlmxCliSchema;
export declare function printRlmxCliSchema(): void;
//# sourceMappingURL=schema.d.ts.map