import { tableFromIPC, Vector, Field, Type, TimeUnit } from 'apache-arrow';
import * as fs from 'fs';

/** Maximum file size to load (100 MB) - larger files show warning and skip preview */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/** Data type prefixes that support min/max computation */
const MIN_MAX_SUPPORTED_TYPES = [
    'Int', 'Uint', 'Float', 'Decimal',  // Numeric
    'Utf8', 'LargeUtf8',                 // String
    'Date', 'Time', 'Timestamp', 'Duration',  // Temporal
    'Bool'                               // Boolean
];

/**
 * Check if a data type supports min/max computation.
 */
function supportsMinMax(dataType: string): boolean {
    return MIN_MAX_SUPPORTED_TYPES.some(prefix => dataType.startsWith(prefix));
}

/**
 * Compute min value for a column. Returns undefined for unsupported types or all-null columns.
 * For temporal types, formats the value as human-readable.
 */
function computeMin(column: Vector, field: Field): string | undefined {
    let min: unknown = undefined;
    for (let i = 0; i < column.length; i++) {
        const val = column.get(i);
        if (val !== null && val !== undefined) {
            if (min === undefined || val < min) {
                min = val;
            }
        }
    }
    return min !== undefined ? formatTemporalValue(min, field) : undefined;
}

/**
 * Compute max value for a column. Returns undefined for unsupported types or all-null columns.
 * For temporal types, formats the value as human-readable.
 */
function computeMax(column: Vector, field: Field): string | undefined {
    let max: unknown = undefined;
    for (let i = 0; i < column.length; i++) {
        const val = column.get(i);
        if (val !== null && val !== undefined) {
            if (max === undefined || val > max) {
                max = val;
            }
        }
    }
    return max !== undefined ? formatTemporalValue(max, field) : undefined;
}

/**
 * Compute distinct count for a column. Returns the number of unique non-null values.
 */
function computeDistinctCount(column: Vector): number {
    const seen = new Set<unknown>();
    for (let i = 0; i < column.length; i++) {
        const val = column.get(i);
        if (val !== null && val !== undefined) {
            // Convert to string for consistent comparison of objects/dates
            seen.add(String(val));
        }
    }
    return seen.size;
}

/**
 * Convert a Map to a string representation for display.
 */
function metadataToString(metadata: Map<string, string>): string {
    if (!metadata || metadata.size === 0) {
        return '';
    }
    const entries: string[] = [];
    metadata.forEach((value, key) => {
        entries.push(`${key}: ${value}`);
    });
    return entries.join(', ');
}

/**
 * Format temporal values (Timestamp, Date, Time) as human-readable strings.
 * For non-temporal types, returns String(val).
 */
function formatTemporalValue(val: unknown, field: Field): string {
    if (val === null || val === undefined) {
        return String(val);
    }

    const typeId = field.type.typeId;

    // Timestamp: get() returns milliseconds for all timestamp types
    if (typeId === Type.Timestamp) {
        const date = new Date(val as number);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tz = (field.type as any).timezone as string | undefined;
        if (tz) {
            // Format: YYYY-MM-DD HH:MM:SS in the specified timezone
            return date.toLocaleString('sv-SE', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).replace(',', '');
        }
        // No timezone: use ISO format with UTC
        return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
    }

    // Date: get() already returns milliseconds regardless of underlying unit
    if (typeId === Type.Date) {
        const date = new Date(val as number);
        return date.toISOString().split('T')[0]; // YYYY-MM-DD
    }

    // Time: convert based on unit to HH:MM:SS.mmm format
    if (typeId === Type.Time) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unit = (field.type as any).unit as number;
        let totalMs: number;
        switch (unit) {
            case TimeUnit.SECOND:
                totalMs = (val as number) * 1000;
                break;
            case TimeUnit.MILLISECOND:
                totalMs = val as number;
                break;
            case TimeUnit.MICROSECOND:
                totalMs = (val as number) / 1000;
                break;
            case TimeUnit.NANOSECOND:
                totalMs = (val as number) / 1000000;
                break;
            default:
                totalMs = val as number;
        }
        const date = new Date(totalMs);
        return date.toISOString().split('T')[1].replace('Z', '');
    }

    return String(val);
}

/** Schema information for a single column */
export interface ColumnSchema {
    columnName: string;
    dataType: string;
    nullable: boolean;
    metadata: string;  // Field metadata as string
}

/** Statistics for a single column */
export interface ColumnStats {
    columnName: string;
    nullCount: number;
    distinctCount?: number;  // Only computed for small files
    minValue?: string;
    maxValue?: string;
}

/** Complete information about an IPC file */
export interface IpcFileInfo {
    numColumns: number;
    numRows: number;
    fileSizeBytes: number;
    schemaMetadata: string;  // File-level metadata
    schema: ColumnSchema[];
    stats: ColumnStats[];
    preview: Record<string, (string | null)[]>;
    previewRowCount: number;
    error?: string;
    warning?: string;
}

/**
 * Format file size in human-readable format.
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    } else {
        return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    }
}

/**
 * Analyze an IPC file and return its schema and preview data.
 * Memory-efficient: checks file size first and only loads files under 100MB.
 * @param filePath Path to the IPC file
 * @param previewRows Number of rows to include in preview
 * @param statsThresholdBytes Files larger than this skip min/max computation (null count still computed)
 */
export function analyzeIpcFile(filePath: string, previewRows: number, statsThresholdBytes: number = MAX_FILE_SIZE_BYTES): IpcFileInfo {
    const result: IpcFileInfo = {
        numColumns: 0,
        numRows: 0,
        fileSizeBytes: 0,
        schemaMetadata: '',
        schema: [],
        stats: [],
        preview: {},
        previewRowCount: 0
    };

    try {
        // Check file size first to avoid memory issues
        const fileStats = fs.statSync(filePath);
        result.fileSizeBytes = fileStats.size;

        if (fileStats.size > MAX_FILE_SIZE_BYTES) {
            result.warning = `File is ${formatFileSize(fileStats.size)}. ` +
                `Only file size shown to avoid memory issues.`;
            return result;
        }

        // Read file (safe for files under 100MB)
        const buffer = fs.readFileSync(filePath);
        const table = tableFromIPC(buffer);

        const schema = table.schema;
        result.numColumns = schema.fields.length;
        result.numRows = table.numRows;

        // Extract schema-level metadata
        result.schemaMetadata = metadataToString(schema.metadata);

        // Determine if we should compute expensive stats (only for small files)
        const computeExpensiveStats = fileStats.size <= statsThresholdBytes;

        // Extract schema and statistics separately
        for (const field of schema.fields) {
            const column = table.getChild(field.name);
            const dataType = String(field.type);

            // Schema information
            result.schema.push({
                columnName: field.name,
                dataType: dataType,
                nullable: field.nullable,
                metadata: metadataToString(field.metadata)
            });

            // Statistics
            const colStats: ColumnStats = {
                columnName: field.name,
                nullCount: column?.nullCount ?? 0
            };

            // Compute expensive stats only for small files
            if (computeExpensiveStats && column) {
                // Distinct count for all types
                colStats.distinctCount = computeDistinctCount(column);

                // Min/max only for supported types
                if (supportsMinMax(dataType)) {
                    colStats.minValue = computeMin(column, field);
                    colStats.maxValue = computeMax(column, field);
                }
            }

            result.stats.push(colStats);
        }

        // Get preview rows
        const rowCount = Math.min(previewRows, table.numRows);
        result.previewRowCount = rowCount;

        for (const field of schema.fields) {
            const column = table.getChild(field.name);
            const values: (string | null)[] = [];

            for (let i = 0; i < rowCount; i++) {
                const val = column?.get(i);
                values.push(val !== null && val !== undefined ? formatTemporalValue(val, field) : null);
            }
            result.preview[field.name] = values;
        }
    } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
    }

    return result;
}
