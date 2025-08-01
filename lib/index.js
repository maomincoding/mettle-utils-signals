// An named symbol/brand for detecting Signal instances even when they weren't
// created using the same signals library version.
const BRAND_SYMBOL = Symbol.for('mettle-signals');
// Flags for Computed and Effect.
const RUNNING = 1 << 0;
const NOTIFIED = 1 << 1;
const OUTDATED = 1 << 2;
const DISPOSED = 1 << 3;
const HAS_ERROR = 1 << 4;
const TRACKING = 1 << 5;
function startBatch() {
    batchDepth++;
}
function endBatch() {
    if (batchDepth > 1) {
        batchDepth--;
        return;
    }
    let error;
    let hasError = false;
    while (batchedEffect !== undefined) {
        let effect = batchedEffect;
        batchedEffect = undefined;
        batchIteration++;
        while (effect !== undefined) {
            const next = effect._nextBatchedEffect;
            effect._nextBatchedEffect = undefined;
            effect._flags &= ~NOTIFIED;
            if (!(effect._flags & DISPOSED) && needsToRecompute(effect)) {
                try {
                    effect._callback();
                }
                catch (err) {
                    if (!hasError) {
                        error = err;
                        hasError = true;
                    }
                }
            }
            effect = next;
        }
    }
    batchIteration = 0;
    batchDepth--;
    if (hasError) {
        throw error;
    }
}
/**
 * Combine multiple value updates into one "commit" at the end of the provided callback.
 *
 * Batches can be nested and changes are only flushed once the outermost batch callback
 * completes.
 *
 * Accessing a signal that has been modified within a batch will reflect its updated
 * value.
 *
 * @param fn The callback function.
 * @returns The value returned by the callback.
 */
function batch(fn) {
    if (batchDepth > 0) {
        return fn();
    }
    /*@__INLINE__**/ startBatch();
    try {
        return fn();
    }
    finally {
        endBatch();
    }
}
// Currently evaluated computed or effect.
let evalContext = undefined;
/**
 * Run a callback function that can access signal values without
 * subscribing to the signal updates.
 *
 * @param fn The callback function.
 * @returns The value returned by the callback.
 */
function untracked(fn) {
    const prevContext = evalContext;
    evalContext = undefined;
    try {
        return fn();
    }
    finally {
        evalContext = prevContext;
    }
}
// Effects collected into a batch.
let batchedEffect = undefined;
let batchDepth = 0;
let batchIteration = 0;
// A global version number for signals, used for fast-pathing repeated
// computed.peek()/computed.value calls when nothing has changed globally.
let globalVersion = 0;
function addDependency(signal) {
    if (evalContext === undefined) {
        return undefined;
    }
    let node = signal._node;
    if (node === undefined || node._target !== evalContext) {
        /**
         * `signal` is a new dependency. Create a new dependency node, and set it
         * as the tail of the current context's dependency list. e.g:
         *
         * { A <-> B       }
         *         ↑     ↑
         *        tail  node (new)
         *               ↓
         * { A <-> B <-> C }
         *               ↑
         *              tail (evalContext._sources)
         */
        node = {
            _version: 0,
            _source: signal,
            _prevSource: evalContext._sources,
            _nextSource: undefined,
            _target: evalContext,
            _prevTarget: undefined,
            _nextTarget: undefined,
            _rollbackNode: node,
        };
        if (evalContext._sources !== undefined) {
            evalContext._sources._nextSource = node;
        }
        evalContext._sources = node;
        signal._node = node;
        // Subscribe to change notifications from this dependency if we're in an effect
        // OR evaluating a computed signal that in turn has subscribers.
        if (evalContext._flags & TRACKING) {
            signal._subscribe(node);
        }
        return node;
    }
    else if (node._version === -1) {
        // `signal` is an existing dependency from a previous evaluation. Reuse it.
        node._version = 0;
        /**
         * If `node` is not already the current tail of the dependency list (i.e.
         * there is a next node in the list), then make the `node` the new tail. e.g:
         *
         * { A <-> B <-> C <-> D }
         *         ↑           ↑
         *        node   ┌─── tail (evalContext._sources)
         *         └─────│─────┐
         *               ↓     ↓
         * { A <-> C <-> D <-> B }
         *                     ↑
         *                    tail (evalContext._sources)
         */
        if (node._nextSource !== undefined) {
            node._nextSource._prevSource = node._prevSource;
            if (node._prevSource !== undefined) {
                node._prevSource._nextSource = node._nextSource;
            }
            node._prevSource = evalContext._sources;
            node._nextSource = undefined;
            evalContext._sources._nextSource = node;
            evalContext._sources = node;
        }
        // We can assume that the currently evaluated effect / computed signal is already
        // subscribed to change notifications from `signal` if needed.
        return node;
    }
    return undefined;
}
/** @internal */
// A class with the same name has already been declared, so we need to ignore
// TypeScript's warning about a redeclared variable.
//
// The previously declared class is implemented here with ES5-style prototypes.
// This enables better control of the transpiled output size.
// @ts-ignore: "Cannot redeclare exported variable 'Signal'."
function Signal(value, options) {
    this._value = value;
    this._version = 0;
    this._node = undefined;
    this._targets = undefined;
    this._watched = options?.watched;
    this._unwatched = options?.unwatched;
    this.name = options?.name;
}
Signal.prototype.brand = BRAND_SYMBOL;
Signal.prototype._refresh = function () {
    return true;
};
Signal.prototype._subscribe = function (node) {
    const targets = this._targets;
    if (targets !== node && node._prevTarget === undefined) {
        node._nextTarget = targets;
        this._targets = node;
        if (targets !== undefined) {
            targets._prevTarget = node;
        }
        else {
            untracked(() => {
                this._watched?.call(this);
            });
        }
    }
};
Signal.prototype._unsubscribe = function (node) {
    // Only run the unsubscribe step if the signal has any subscribers to begin with.
    if (this._targets !== undefined) {
        const prev = node._prevTarget;
        const next = node._nextTarget;
        if (prev !== undefined) {
            prev._nextTarget = next;
            node._prevTarget = undefined;
        }
        if (next !== undefined) {
            next._prevTarget = prev;
            node._nextTarget = undefined;
        }
        if (node === this._targets) {
            this._targets = next;
            if (next === undefined) {
                untracked(() => {
                    this._unwatched?.call(this);
                });
            }
        }
    }
};
Signal.prototype.subscribe = function (fn) {
    return effect(() => {
        const value = this.value;
        const prevContext = evalContext;
        evalContext = undefined;
        try {
            fn(value);
        }
        finally {
            evalContext = prevContext;
        }
    }, { name: 'sub' });
};
Signal.prototype.valueOf = function () {
    return this.value;
};
Signal.prototype.toString = function () {
    return this.value + '';
};
Signal.prototype.toJSON = function () {
    return this.value;
};
Signal.prototype.peek = function () {
    const prevContext = evalContext;
    evalContext = undefined;
    try {
        return this.value;
    }
    finally {
        evalContext = prevContext;
    }
};
Object.defineProperty(Signal.prototype, 'value', {
    get() {
        const node = addDependency(this);
        if (node !== undefined) {
            node._version = this._version;
        }
        return this._value;
    },
    set(value) {
        if (value !== this._value) {
            if (batchIteration > 100) {
                throw new Error('Cycle detected');
            }
            this._value = value;
            this._version++;
            globalVersion++;
            /**@__INLINE__*/ startBatch();
            try {
                for (let node = this._targets; node !== undefined; node = node._nextTarget) {
                    node._target._notify();
                }
            }
            finally {
                endBatch();
            }
        }
    },
});
export function signal(value, options) {
    return new Signal(value, options);
}
function needsToRecompute(target) {
    // Check the dependencies for changed values. The dependency list is already
    // in order of use. Therefore if multiple dependencies have changed values, only
    // the first used dependency is re-evaluated at this point.
    for (let node = target._sources; node !== undefined; node = node._nextSource) {
        if (
        // If the dependency has definitely been updated since its version number
        // was observed, then we need to recompute. This first check is not strictly
        // necessary for correctness, but allows us to skip the refresh call if the
        // dependency has already been updated.
        node._source._version !== node._version ||
            // Refresh the dependency. If there's something blocking the refresh (e.g. a
            // dependency cycle), then we need to recompute.
            !node._source._refresh() ||
            // If the dependency got a new version after the refresh, then we need to recompute.
            node._source._version !== node._version) {
            return true;
        }
    }
    // If none of the dependencies have changed values since last recompute then
    // there's no need to recompute.
    return false;
}
function prepareSources(target) {
    /**
     * 1. Mark all current sources as re-usable nodes (version: -1)
     * 2. Set a rollback node if the current node is being used in a different context
     * 3. Point 'target._sources' to the tail of the doubly-linked list, e.g:
     *
     *    { undefined <- A <-> B <-> C -> undefined }
     *                   ↑           ↑
     *                   │           └──────┐
     * target._sources = A; (node is head)  │
     *                   ↓                  │
     * target._sources = C; (node is tail) ─┘
     */
    for (let node = target._sources; node !== undefined; node = node._nextSource) {
        const rollbackNode = node._source._node;
        if (rollbackNode !== undefined) {
            node._rollbackNode = rollbackNode;
        }
        node._source._node = node;
        node._version = -1;
        if (node._nextSource === undefined) {
            target._sources = node;
            break;
        }
    }
}
function cleanupSources(target) {
    let node = target._sources;
    let head = undefined;
    /**
     * At this point 'target._sources' points to the tail of the doubly-linked list.
     * It contains all existing sources + new sources in order of use.
     * Iterate backwards until we find the head node while dropping old dependencies.
     */
    while (node !== undefined) {
        const prev = node._prevSource;
        /**
         * The node was not re-used, unsubscribe from its change notifications and remove itself
         * from the doubly-linked list. e.g:
         *
         * { A <-> B <-> C }
         *         ↓
         *    { A <-> C }
         */
        if (node._version === -1) {
            node._source._unsubscribe(node);
            if (prev !== undefined) {
                prev._nextSource = node._nextSource;
            }
            if (node._nextSource !== undefined) {
                node._nextSource._prevSource = prev;
            }
        }
        else {
            /**
             * The new head is the last node seen which wasn't removed/unsubscribed
             * from the doubly-linked list. e.g:
             *
             * { A <-> B <-> C }
             *   ↑     ↑     ↑
             *   │     │     └ head = node
             *   │     └ head = node
             *   └ head = node
             */
            head = node;
        }
        node._source._node = node._rollbackNode;
        if (node._rollbackNode !== undefined) {
            node._rollbackNode = undefined;
        }
        node = prev;
    }
    target._sources = head;
}
/** @internal */
function Computed(fn, options) {
    Signal.call(this, undefined);
    this._fn = fn;
    this._sources = undefined;
    this._globalVersion = globalVersion - 1;
    this._flags = OUTDATED;
    this._watched = options?.watched;
    this._unwatched = options?.unwatched;
    this.name = options?.name;
}
Computed.prototype = new Signal();
Computed.prototype._refresh = function () {
    this._flags &= ~NOTIFIED;
    if (this._flags & RUNNING) {
        return false;
    }
    // If this computed signal has subscribed to updates from its dependencies
    // (TRACKING flag set) and none of them have notified about changes (OUTDATED
    // flag not set), then the computed value can't have changed.
    if ((this._flags & (OUTDATED | TRACKING)) === TRACKING) {
        return true;
    }
    this._flags &= ~OUTDATED;
    if (this._globalVersion === globalVersion) {
        return true;
    }
    this._globalVersion = globalVersion;
    // Mark this computed signal running before checking the dependencies for value
    // changes, so that the RUNNING flag can be used to notice cyclical dependencies.
    this._flags |= RUNNING;
    if (this._version > 0 && !needsToRecompute(this)) {
        this._flags &= ~RUNNING;
        return true;
    }
    const prevContext = evalContext;
    try {
        prepareSources(this);
        evalContext = this;
        const value = this._fn();
        if (this._flags & HAS_ERROR || this._value !== value || this._version === 0) {
            this._value = value;
            this._flags &= ~HAS_ERROR;
            this._version++;
        }
    }
    catch (err) {
        this._value = err;
        this._flags |= HAS_ERROR;
        this._version++;
    }
    evalContext = prevContext;
    cleanupSources(this);
    this._flags &= ~RUNNING;
    return true;
};
Computed.prototype._subscribe = function (node) {
    if (this._targets === undefined) {
        this._flags |= OUTDATED | TRACKING;
        // A computed signal subscribes lazily to its dependencies when it
        // gets its first subscriber.
        for (let node = this._sources; node !== undefined; node = node._nextSource) {
            node._source._subscribe(node);
        }
    }
    Signal.prototype._subscribe.call(this, node);
};
Computed.prototype._unsubscribe = function (node) {
    // Only run the unsubscribe step if the computed signal has any subscribers.
    if (this._targets !== undefined) {
        Signal.prototype._unsubscribe.call(this, node);
        // Computed signal unsubscribes from its dependencies when it loses its last subscriber.
        // This makes it possible for unreferences subgraphs of computed signals to get garbage collected.
        if (this._targets === undefined) {
            this._flags &= ~TRACKING;
            for (let node = this._sources; node !== undefined; node = node._nextSource) {
                node._source._unsubscribe(node);
            }
        }
    }
};
Computed.prototype._notify = function () {
    if (!(this._flags & NOTIFIED)) {
        this._flags |= OUTDATED | NOTIFIED;
        for (let node = this._targets; node !== undefined; node = node._nextTarget) {
            node._target._notify();
        }
    }
};
Object.defineProperty(Computed.prototype, 'value', {
    get() {
        if (this._flags & RUNNING) {
            throw new Error('Cycle detected');
        }
        const node = addDependency(this);
        this._refresh();
        if (node !== undefined) {
            node._version = this._version;
        }
        if (this._flags & HAS_ERROR) {
            throw this._value;
        }
        return this._value;
    },
});
/**
 * Create a new signal that is computed based on the values of other signals.
 *
 * The returned computed signal is read-only, and its value is automatically
 * updated when any signals accessed from within the callback function change.
 *
 * @param fn The effect callback.
 * @returns A new read-only signal.
 */
function computed(fn, options) {
    return new Computed(fn, options);
}
function cleanupEffect(effect) {
    const cleanup = effect._cleanup;
    effect._cleanup = undefined;
    if (typeof cleanup === 'function') {
        /*@__INLINE__**/ startBatch();
        // Run cleanup functions always outside of any context.
        const prevContext = evalContext;
        evalContext = undefined;
        try {
            cleanup();
        }
        catch (err) {
            effect._flags &= ~RUNNING;
            effect._flags |= DISPOSED;
            disposeEffect(effect);
            throw err;
        }
        finally {
            evalContext = prevContext;
            endBatch();
        }
    }
}
function disposeEffect(effect) {
    for (let node = effect._sources; node !== undefined; node = node._nextSource) {
        node._source._unsubscribe(node);
    }
    effect._fn = undefined;
    effect._sources = undefined;
    cleanupEffect(effect);
}
function endEffect(prevContext) {
    if (evalContext !== this) {
        throw new Error('Out-of-order effect');
    }
    cleanupSources(this);
    evalContext = prevContext;
    this._flags &= ~RUNNING;
    if (this._flags & DISPOSED) {
        disposeEffect(this);
    }
    endBatch();
}
/** @internal */
function Effect(fn, options) {
    this._fn = fn;
    this._cleanup = undefined;
    this._sources = undefined;
    this._nextBatchedEffect = undefined;
    this._flags = TRACKING;
    this.name = options?.name;
}
Effect.prototype._callback = function () {
    const finish = this._start();
    try {
        if (this._flags & DISPOSED)
            return;
        if (this._fn === undefined)
            return;
        const cleanup = this._fn();
        if (typeof cleanup === 'function') {
            this._cleanup = cleanup;
        }
    }
    finally {
        finish();
    }
};
Effect.prototype._start = function () {
    if (this._flags & RUNNING) {
        throw new Error('Cycle detected');
    }
    this._flags |= RUNNING;
    this._flags &= ~DISPOSED;
    cleanupEffect(this);
    prepareSources(this);
    /*@__INLINE__**/ startBatch();
    const prevContext = evalContext;
    evalContext = this;
    return endEffect.bind(this, prevContext);
};
Effect.prototype._notify = function () {
    if (!(this._flags & NOTIFIED)) {
        this._flags |= NOTIFIED;
        this._nextBatchedEffect = batchedEffect;
        batchedEffect = this;
    }
};
Effect.prototype._dispose = function () {
    this._flags |= DISPOSED;
    if (!(this._flags & RUNNING)) {
        disposeEffect(this);
    }
};
Effect.prototype.dispose = function () {
    this._dispose();
};
/**
 * Create an effect to run arbitrary code in response to signal changes.
 *
 * An effect tracks which signals are accessed within the given callback
 * function `fn`, and re-runs the callback when those signals change.
 *
 * The callback may return a cleanup function. The cleanup function gets
 * run once, either when the callback is next called or when the effect
 * gets disposed, whichever happens first.
 *
 * @param fn The effect callback.
 * @returns A function for disposing the effect.
 */
function effect(fn, options) {
    const effect = new Effect(fn, options);
    try {
        effect._callback();
    }
    catch (err) {
        effect._dispose();
        throw err;
    }
    // Return a bound function instead of a wrapper like `() => effect._dispose()`,
    // because bound functions seem to be just as fast and take up a lot less memory.
    const dispose = effect._dispose.bind(effect);
    dispose[Symbol.dispose] = dispose;
    return dispose;
}
export { computed, effect, batch, untracked, Signal, Effect, Computed };
