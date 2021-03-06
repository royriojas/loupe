var AndView = require('ampersand-view');
var templates = require('../templates');

var delay = require('../lib/delay');
var instrumentCode = require('../lib/instrument-code');
var wrapInsertionPoints = require('../lib/wrap-insertion-points');
var tag = require('../lib/tag');

var weevil = require('weevil');
var deval = require('deval');

var cleanupCode = function (code) {
    return code.replace(/<br>/g, '\n');
};

var instrumentAndWrapHTML = function (code) {
    var instrumented = instrumentCode(code, {
        before: function (id, node) {
            return deval(function (id, type, source) {
                weevil.send('node:before', { id: $id$, type: "$type$", source: $source$ }), delay()
            }, id, node.type, JSON.stringify(node.source()));
        },
        after: function (id, node) {
            return deval(function (id) {
                weevil.send('node:after', { id: $id$ }), delay()
            }, id);
        }
    });

    var html = wrapInsertionPoints(code, instrumented.insertionPoints, {
        before: function (id) {
            return tag.o('span', {
                id: 'node-' + id,
                class: 'code-node',
                //style: "background: rgba(0,0,0,0.2);"
            });
        },
        after: function (id) {
            return tag.c('span');
        }
    });

    return {
        code: instrumented.code,
        html: html
    };
};

var makeWorkerCode = function (code) {
    return deval(function (delayMaker, code) {
        var delayMaker = $delayMaker$;

        var delay = delayMaker(750);

        //Override setTimeout
        var _setTimeout = self.setTimeout;
        self.setTimeout = function (fn, delay/*, args...*/) {
            var args = Array.prototype.slice.call(arguments);
            fn = args.shift();
            var timerId;

            var queued = +new Date();
            var data = { id: timerId, delay: delay, created: +new Date(), state: 'timing' };
            args.unshift(function () {
                data.state = 'started';
                data.started = +new Date();
                data.error = (data.started - data.queued) - delay;
                weevil.send('timeout:started', data);

                fn.apply(fn, arguments);

                data.state = 'finished';
                data.finished = +new Date();
                weevil.send('timeout:finished', data);
            });

            data.id = _setTimeout.apply(self, args);
            weevil.send('timeout:created', data);
        };

        $code$;

    }, delay.toString(), code);
};

module.exports = AndView.extend({
    initialize: function (options) {
        window.codeView = this;
        this.timeouts = options.timeouts;
        this.stackFrames = options.stackFrames;
    },
    events: {
        'focusout [data-hook=editor]' : 'runCode',
        'focusin [data-hook=editor]' : 'editCode'
    },
    template: templates.code,
    render: function () {
        this.renderWithTemplate();
        this.editor = this.queryByHook('editor') || this.el;
        return this;
    },
    log: console.log.bind(console, 'log'),
    editCode: function (e) {
        console.log('EDIT');
        if (this.rawCode) $(this.$editor).html(this.rawCode);
        if (this.worker) this.worker.kill();

        this.timeouts.reset();
        this.stackFrames.reset();
    },
    runCode: function (e) {
        console.log('RUN');
        this.rawCode = $(this.editor).text().trim();
        var code = cleanupCode(this.rawCode);
        this.instrumentAndRun(code);
    },
    instrumentAndRun: function (code) {
        var self = this;
        var instrumented = instrumentAndWrapHTML(code);
        $(this.editor).html(instrumented.html);
        var workerCode = makeWorkerCode(instrumented.code);

        this.worker = weevil(workerCode);
        this.worker
                .on('node:before', function (node) {
                    $('#node-' + node.id).addClass('running');
                })
                .on('node:after', function (node) {
                    $('#node-' + node.id).removeClass('running');
                });

        this.worker
                .on('timeout:created', function (timer) {
                    self.timeouts.add(timer, { merge: true });
                })
                .on('timeout:started', function (timer) {
                    self.timeouts.add(timer, { merge: true });
                })
                .on('timeout:finished', function (timer) {
                    self.timeouts.add(timer, { merge: true });
                });

        this.worker
                .on('node:before', function (node) {
                    node.nodeId = node.id;
                    delete node.id;
                    node.source = $('#node-' + node.nodeId).text();
                    self.stackFrames.add(node, { merge: true });
                })
                .on('node:after', function (node) {
                    var found = self.stackFrames.find(function (n) {
                        console.log("N:", n.nodeId, node.id);
                        return n.nodeId === node.id;
                    });
                    self.stackFrames.remove(found);
                });

    }
});
