import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { tableToIPC, tableFromArrays, makeVector, Table, RecordBatch,
         TimestampSecond, TimestampMillisecond, DateDay, DateMillisecond } from 'apache-arrow';
import { analyzeIpcFile, formatFileSize } from '../ipcAnalyzer';

describe('ipcAnalyzer', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-viewer-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /**
     * Create a test IPC file with sample data.
     */
    function createTestIpcFile(filename: string, data: Record<string, unknown[]>): string {
        const table = tableFromArrays(data);
        const buffer = tableToIPC(table);
        const filePath = path.join(tempDir, filename);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }

    describe('formatFileSize', () => {
        it('formats bytes correctly', () => {
            expect(formatFileSize(500)).toBe('500 B');
            expect(formatFileSize(1024)).toBe('1.0 KB');
            expect(formatFileSize(1536)).toBe('1.5 KB');
            expect(formatFileSize(1048576)).toBe('1.0 MB');
            expect(formatFileSize(1073741824)).toBe('1.0 GB');
        });
    });

    describe('analyzeIpcFile', () => {
        it('analyzes a simple IPC file with string columns', () => {
            const filePath = createTestIpcFile('test-strings.ipc', {
                'Name': ['Alice', 'Bob', 'Charlie'],
                'City': ['NYC', 'LA', 'Chicago']
            });

            const result = analyzeIpcFile(filePath, 5);

            expect(result.error).toBeUndefined();
            expect(result.numColumns).toBe(2);
            expect(result.numRows).toBe(3);
            expect(result.schema.length).toBe(2);
            expect(result.schema[0].columnName).toBe('Name');
            expect(result.schema[1].columnName).toBe('City');
            expect(result.previewRowCount).toBe(3);
            expect(result.preview['Name']).toEqual(['Alice', 'Bob', 'Charlie']);
        });

        it('analyzes a file with numeric columns', () => {
            const filePath = createTestIpcFile('test-numbers.ipc', {
                'ID': [1, 2, 3, 4, 5],
                'Value': [10.5, 20.5, 30.5, 40.5, 50.5]
            });

            const result = analyzeIpcFile(filePath, 3);

            expect(result.numColumns).toBe(2);
            expect(result.numRows).toBe(5);
            expect(result.previewRowCount).toBe(3);
            expect(result.preview['ID']?.length).toBe(3);
        });

        it('handles null values correctly', () => {
            const filePath = createTestIpcFile('test-nulls.ipc', {
                'Name': ['Alice', null, 'Charlie'],
                'Age': [25, 30, null]
            });

            const result = analyzeIpcFile(filePath, 5);

            expect(result.numRows).toBe(3);
            expect(result.preview['Name']?.[1]).toBeNull();
            expect(result.preview['Age']?.[2]).toBeNull();
        });

        it('limits preview to requested number of rows', () => {
            const data: Record<string, string[]> = {
                'Name': Array.from({ length: 100 }, (_, i) => `User${i}`)
            };
            const filePath = createTestIpcFile('test-large.ipc', data);

            const result = analyzeIpcFile(filePath, 5);

            expect(result.numRows).toBe(100);
            expect(result.previewRowCount).toBe(5);
            expect(result.preview['Name']?.length).toBe(5);
        });

        it('returns error for non-existent file', () => {
            const result = analyzeIpcFile('/nonexistent/file.ipc', 5);

            expect(result.error).toBeDefined();
            expect(result.error).toMatch(/ENOENT|no such file/);
        });

        it('returns error for invalid IPC file', () => {
            const filePath = path.join(tempDir, 'invalid.ipc');
            fs.writeFileSync(filePath, 'not valid ipc data');

            const result = analyzeIpcFile(filePath, 5);

            expect(result.error).toBeDefined();
        });

        it('returns file size correctly', () => {
            const filePath = createTestIpcFile('test-size.ipc', {
                'Data': ['test']
            });

            const result = analyzeIpcFile(filePath, 5);
            const actualSize = fs.statSync(filePath).size;

            expect(result.fileSizeBytes).toBe(actualSize);
        });

        it('handles empty table', () => {
            const filePath = createTestIpcFile('test-empty.ipc', {
                'Column': [] as string[]
            });

            const result = analyzeIpcFile(filePath, 5);

            expect(result.numRows).toBe(0);
            expect(result.previewRowCount).toBe(0);
        });

        it('returns schema metadata as empty string when not present', () => {
            const filePath = createTestIpcFile('test-metadata.ipc', {
                'Value': [1, 2, 3]
            });

            const result = analyzeIpcFile(filePath, 5);

            // tableFromArrays doesn't add metadata, so it should be empty
            expect(result.schemaMetadata).toBe('');
        });

        it('returns field metadata as empty string when not present', () => {
            const filePath = createTestIpcFile('test-field-metadata.ipc', {
                'Value': [1, 2, 3]
            });

            const result = analyzeIpcFile(filePath, 5);

            expect(result.schema[0].metadata).toBe('');
        });
    });

    describe('column statistics', () => {
        it('always computes null count', () => {
            const filePath = createTestIpcFile('test-nullcount.ipc', {
                'Name': ['Alice', null, 'Charlie', null, 'Eve'],
                'Age': [25, 30, null, 40, 50]
            });

            const result = analyzeIpcFile(filePath, 5);

            expect(result.stats[0].nullCount).toBe(2);
            expect(result.stats[1].nullCount).toBe(1);
        });

        it('computes min/max for numeric columns when under threshold', () => {
            const filePath = createTestIpcFile('test-minmax-numeric.ipc', {
                'ID': [5, 1, 3, 2, 4]
            });

            // Large threshold - should compute min/max
            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.stats[0].minValue).toBe('1');
            expect(result.stats[0].maxValue).toBe('5');
        });

        it('skips min/max for dictionary-encoded string columns', () => {
            // Note: tableFromArrays creates Dictionary<Int32, Utf8> for strings
            // Dictionary types are skipped for min/max per the design (complexity of decoding)
            const filePath = createTestIpcFile('test-minmax-string.ipc', {
                'Name': ['Charlie', 'Alice', 'Bob']
            });

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            // Dictionary types don't compute min/max
            expect(result.stats[0].minValue).toBeUndefined();
            expect(result.stats[0].maxValue).toBeUndefined();
            // But null count is still computed
            expect(result.stats[0].nullCount).toBe(0);
        });

        it('handles all-null columns', () => {
            const filePath = createTestIpcFile('test-allnull.ipc', {
                'Value': [null, null, null]
            });

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.stats[0].nullCount).toBe(3);
            expect(result.stats[0].minValue).toBeUndefined();
            expect(result.stats[0].maxValue).toBeUndefined();
        });

        it('handles column with no nulls', () => {
            const filePath = createTestIpcFile('test-nonulls.ipc', {
                'Value': [1, 2, 3, 4, 5]
            });

            const result = analyzeIpcFile(filePath, 5);

            expect(result.stats[0].nullCount).toBe(0);
        });

        it('computes distinct count for small files', () => {
            const filePath = createTestIpcFile('test-distinct.ipc', {
                'Value': [1, 2, 2, 3, 3, 3, 4, 5]
            });

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.stats[0].distinctCount).toBe(5);
        });

        it('skips distinct count for large files', () => {
            const filePath = createTestIpcFile('test-distinct-large.ipc', {
                'Value': [1, 2, 3]
            });

            // Very small threshold - forces large file behavior
            const result = analyzeIpcFile(filePath, 5, 1);

            expect(result.stats[0].distinctCount).toBeUndefined();
        });
    });

    describe('stats threshold behavior', () => {
        it('computes full stats when file size <= threshold', () => {
            const filePath = createTestIpcFile('test-small.ipc', {
                'Value': [10, 20, 30]
            });

            // Large threshold
            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.stats[0].nullCount).toBe(0);
            expect(result.stats[0].minValue).toBe('10');
            expect(result.stats[0].maxValue).toBe('30');
            expect(result.stats[0].distinctCount).toBe(3);
        });

        it('skips expensive stats when file size > threshold', () => {
            const filePath = createTestIpcFile('test-threshold.ipc', {
                'Value': [10, 20, 30]
            });

            // Very small threshold (1 byte) - forces large file behavior
            const result = analyzeIpcFile(filePath, 5, 1);

            // Null count should still be computed
            expect(result.stats[0].nullCount).toBe(0);
            // Expensive stats should NOT be computed
            expect(result.stats[0].minValue).toBeUndefined();
            expect(result.stats[0].maxValue).toBeUndefined();
            expect(result.stats[0].distinctCount).toBeUndefined();
        });

        it('respects custom threshold parameter', () => {
            const filePath = createTestIpcFile('test-custom-threshold.ipc', {
                'Value': [1, 2, 3, 4, 5]
            });
            const fileSize = fs.statSync(filePath).size;

            // Threshold exactly at file size - should compute stats
            const result1 = analyzeIpcFile(filePath, 5, fileSize);
            expect(result1.stats[0].minValue).toBe('1');
            expect(result1.stats[0].distinctCount).toBe(5);

            // Threshold just below file size - should skip expensive stats
            const result2 = analyzeIpcFile(filePath, 5, fileSize - 1);
            expect(result2.stats[0].minValue).toBeUndefined();
            expect(result2.stats[0].distinctCount).toBeUndefined();
        });
    });

    describe('temporal type formatting', () => {
        it('formats timestamps with timezone in the specified timezone', () => {
            // Create IPC with TimestampSecond column with America/New_York timezone
            // 1704229200 seconds = 2024-01-02 16:00:00 EST (21:00:00 UTC)
            const tsType = new TimestampSecond('America/New_York');
            const vec = makeVector({ type: tsType, data: new BigInt64Array([1704229200n, 1704315600n]) });
            const batch = new RecordBatch({ ts: vec });
            const table = new Table(batch);
            const buffer = tableToIPC(table);
            const filePath = path.join(tempDir, 'test-ts-tz.ipc');
            fs.writeFileSync(filePath, buffer);

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.error).toBeUndefined();
            // Preview should show formatted datetime in America/New_York timezone
            expect(result.preview['ts']?.[0]).toMatch(/2024-01-02 16:00:00/);
            // Min/max should also be formatted
            expect(result.stats[0].minValue).toMatch(/2024-01-02 16:00:00/);
        });

        it('formats timestamps without timezone as UTC ISO format', () => {
            // Create IPC with TimestampMillisecond column without timezone
            // 1704229200000 ms = 2024-01-02T21:00:00.000Z
            const tsType = new TimestampMillisecond();
            const vec = makeVector({ type: tsType, data: new BigInt64Array([1704229200000n, 1704315600000n]) });
            const batch = new RecordBatch({ ts: vec });
            const table = new Table(batch);
            const buffer = tableToIPC(table);
            const filePath = path.join(tempDir, 'test-ts-no-tz.ipc');
            fs.writeFileSync(filePath, buffer);

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.error).toBeUndefined();
            // Preview should show ISO format with UTC
            expect(result.preview['ts']?.[0]).toBe('2024-01-02 21:00:00.000 UTC');
        });

        it('formats DateDay columns as YYYY-MM-DD', () => {
            // Create IPC with DateDay column
            // 19724 days since epoch = 2024-01-02
            const dateType = new DateDay();
            const vec = makeVector({ type: dateType, data: new Int32Array([19724, 19755]) });
            const batch = new RecordBatch({ date: vec });
            const table = new Table(batch);
            const buffer = tableToIPC(table);
            const filePath = path.join(tempDir, 'test-date-day.ipc');
            fs.writeFileSync(filePath, buffer);

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.error).toBeUndefined();
            // Preview should show YYYY-MM-DD format
            expect(result.preview['date']?.[0]).toBe('2024-01-02');
        });

        it('formats DateMillisecond columns as YYYY-MM-DD', () => {
            // Create IPC with DateMillisecond column
            const dateType = new DateMillisecond();
            const vec = makeVector({ type: dateType, data: new BigInt64Array([1704153600000n, 1704240000000n]) });
            const batch = new RecordBatch({ date: vec });
            const table = new Table(batch);
            const buffer = tableToIPC(table);
            const filePath = path.join(tempDir, 'test-date-ms.ipc');
            fs.writeFileSync(filePath, buffer);

            const result = analyzeIpcFile(filePath, 5, 100 * 1024 * 1024);

            expect(result.error).toBeUndefined();
            // Preview should show YYYY-MM-DD format
            expect(result.preview['date']?.[0]).toBe('2024-01-02');
        });

        it('includes timezone in schema dataType for timestamp columns', () => {
            const tsType = new TimestampSecond('America/New_York');
            const vec = makeVector({ type: tsType, data: new BigInt64Array([1704229200n]) });
            const batch = new RecordBatch({ ts: vec });
            const table = new Table(batch);
            const buffer = tableToIPC(table);
            const filePath = path.join(tempDir, 'test-schema-tz.ipc');
            fs.writeFileSync(filePath, buffer);

            const result = analyzeIpcFile(filePath, 5);

            expect(result.error).toBeUndefined();
            // Schema dataType should include timezone
            expect(result.schema[0].dataType).toContain('America/New_York');
        });
    });
});
