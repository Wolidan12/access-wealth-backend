// sqlite3 uses a native binding that may be unavailable when a deployment
// disables install scripts or has no prebuilt binary for its Node version.
// Node 22+ includes node:sqlite, so expose a small callback-compatible adapter
// as a fallback for this repository's existing sqlite3 API calls.
function createNodeSqliteCompat() {
    const { DatabaseSync } = require('node:sqlite');

    class CompatDatabase {
        constructor(filename, callback) {
            this.database = new DatabaseSync(filename);
            this.queue = [];
            this.running = false;
            this.closed = false;
            if (callback) setImmediate(() => callback(null));
        }

        configure() {}
        on() { return this; }
        serialize(callback) { callback(); }

        enqueue(operation, callback) {
            this.queue.push({ operation, callback });
            this.drain();
        }

        drain() {
            if (this.running || this.closed || !this.queue.length) return;
            this.running = true;
            const item = this.queue.shift();
            setImmediate(() => {
                let result;
                let error;
                try {
                    result = item.operation();
                } catch (operationError) {
                    error = operationError;
                }

                this.running = false;
                if (item.callback) {
                    const context = {
                        changes: result && result.changes ? result.changes : 0,
                        lastID: result && result.lastInsertRowid ? Number(result.lastInsertRowid) : 0
                    };
                    item.callback.call(context, error, error ? undefined : result);
                } else if (error) {
                    console.error('[DB] SQLite operation failed:', error.message);
                }
                this.drain();
            });
        }

        normalizeParams(params) {
            if (params === undefined) return [];
            return Array.isArray(params) ? params : [params];
        }

        run(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = undefined;
            }
            const values = this.normalizeParams(params);
            this.enqueue(() => this.database.prepare(sql).run(...values), callback);
            return this;
        }

        get(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = undefined;
            }
            const values = this.normalizeParams(params);
            this.enqueue(() => this.database.prepare(sql).get(...values), (error, row) => {
                callback(error, error ? undefined : row || undefined);
            });
            return this;
        }

        all(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = undefined;
            }
            const values = this.normalizeParams(params);
            this.enqueue(() => this.database.prepare(sql).all(...values), (error, rows) => {
                callback(error, error ? undefined : rows || []);
            });
            return this;
        }

        close(callback) {
            this.enqueue(() => {
                this.database.close();
                this.closed = true;
            }, callback);
        }
    }

    return {
        Database: CompatDatabase,
        verbose() { return this; }
    };
}

try {
    module.exports = require('sqlite3').verbose();
} catch (error) {
    try {
        module.exports = createNodeSqliteCompat();
        console.warn('WARN: sqlite3 native binding is unavailable; using the Node SQLite fallback.', error.message);
    } catch (fallbackError) {
        throw new Error(`SQLite dependency is unavailable: ${fallbackError.message}`);
    }
}
