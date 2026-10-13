/**
 * Order migration — filter, count, and export SFCC order XML part files to IMPEX in batches.
 */
(function () {
    'use strict';

    function readUi(root) {
        if (window.AccAttrPreflight && window.AccAttrPreflight.readMigrationUi) {
            var fromJson = window.AccAttrPreflight.readMigrationUi();
            if (fromJson && fromJson.sourceShort) return fromJson;
        }
        if (!root) return {};
        try {
            var raw = root.getAttribute('data-migration-ui');
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function readCfg() {
        var root = document.getElementById('acc-ord-root');
        if (!root) return { ui: {} };
        return {
            countUrl:           root.getAttribute('data-count-url') || '',
            exportUrl:          root.getAttribute('data-export-url') || '',
            checkAttrsUrl:      root.getAttribute('data-check-attrs-url') || '',
            createAttrsUrl:     root.getAttribute('data-create-attrs-url') || '',
            clearAttrMapUrl:    root.getAttribute('data-clear-attr-map-url') || '',
            dataWizardEntryUrl: root.getAttribute('data-wizard-entry-url') || '',
            impexPath:          root.getAttribute('data-impex-path') || '',
            ui:                 readUi(root)
        };
    }

    function escHtml(val) {
        if (val === null || val === undefined) return '';
        return String(val)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmtNum(n) {
        return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function post(url, params, onDone) {
        if (!url) {
            onDone({ ok: false, error: 'API URL not configured' });
            return;
        }
        var req = new XMLHttpRequest();
        req.open('POST', url, true);
        req.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        req.onreadystatechange = function () {
            if (req.readyState !== 4) return;
            var data;
            try { data = JSON.parse(req.responseText); } catch (e) { data = { ok: false, error: 'Parse error' }; }
            onDone(data);
        };
        req.onerror = function () { onDone({ ok: false, error: 'Network error' }); };
        req.send(params);
    }

    function get(url, onDone) {
        if (!url) {
            onDone({ ok: false, error: 'API URL not configured' });
            return;
        }
        var req = new XMLHttpRequest();
        req.open('GET', url, true);
        req.onreadystatechange = function () {
            if (req.readyState !== 4) return;
            var data;
            try { data = JSON.parse(req.responseText); } catch (e) { data = { ok: false, error: 'Parse error' }; }
            onDone(data);
        };
        req.onerror = function () { onDone({ ok: false, error: 'Network error' }); };
        req.send(null);
    }

    function boot() {
        var cfg = readCfg();
        var ui  = cfg.ui || {};
        if (window.AccAttrPreflight && window.AccAttrPreflight.bindClearOnLeave) {
            window.AccAttrPreflight.bindClearOnLeave(cfg.clearAttrMapUrl, 'Accelerator-OrderMigration');
        }
        var yearsEl       = document.getElementById('acc-ord-years');
        var stateEl       = document.getElementById('acc-ord-order-state');
        var payEl         = document.getElementById('acc-ord-payment-state');
        var maxEl         = document.getElementById('acc-ord-max-count');
        var customersEl   = document.getElementById('acc-ord-customer-ids');
        var countBtn      = document.getElementById('acc-ord-count-btn');
        var countValueEl  = document.getElementById('acc-ord-count-value');
        var countExportEl = document.getElementById('acc-ord-count-export');
        var startBtn      = document.getElementById('full-start-btn');
        var fullPhaseList = document.getElementById('full-phase-list');
        var fullOverallEl = document.getElementById('full-move-overall');
        var checkAttrsBtn = document.getElementById('acc-check-attrs-btn');
        var attrCheckMsg  = document.getElementById('acc-attr-check-msg');
        var attrResults   = document.getElementById('acc-attr-results');

        var pendingMissing = [];
        var pendingMapped = [];
        var pendingCoverage = [];
        var pendingSkipped = [];
        var fullRunning    = false;
        var fullFinished   = false;
        var lastCount      = 0;

        function setPhase(prefix, id, state, detail, pct) {
            var li  = document.getElementById(prefix + '-phase-' + id);
            var st  = document.getElementById(prefix + '-status-' + id);
            var det = document.getElementById(prefix + '-detail-' + id);
            var bar = document.getElementById(prefix + '-bar-' + id);
            if (!li) return;
            li.className = 'acc-phases__item acc-phases__item--' + state;
            if (st)  st.textContent = state;
            if (det && detail !== null) det.textContent = detail || '';
            if (bar && pct !== null && pct !== undefined) bar.style.width = pct + '%';
        }

        function getFilterParams() {
            var years = yearsEl ? yearsEl.value : '1';
            var body  = 'years=' + encodeURIComponent(years);
            if (stateEl && stateEl.value) body += '&orderState=' + encodeURIComponent(stateEl.value);
            if (payEl && payEl.value) body += '&paymentState=' + encodeURIComponent(payEl.value);
            if (maxEl && maxEl.value) body += '&maxCount=' + encodeURIComponent(maxEl.value);
            if (customersEl && customersEl.value.trim()) body += '&customerIds=' + encodeURIComponent(customersEl.value.trim());
            return body;
        }

        function showCountIdle() {
            if (!countValueEl) return;
            fullFinished = false;
            countValueEl.textContent = 'Set your filters, then check how many orders match.';
            countValueEl.className = 'acc-order-count__value acc-order-count__value--idle';
            if (countExportEl) countExportEl.style.display = 'none';
            lastCount = 0;
            if (startBtn) {
                startBtn.disabled = true;
                startBtn.textContent = 'Start Migration (Build XML)';
            }
            if (fullPhaseList) fullPhaseList.style.display = 'none';
            if (fullOverallEl) fullOverallEl.textContent = '';
        }

        function showCountLoading() {
            if (!countValueEl) return;
            countValueEl.textContent = ui.orderCountChecking || 'Checking...';
            countValueEl.className = 'acc-order-count__value acc-order-count__value--loading';
            if (countExportEl) countExportEl.style.display = 'none';
        }

        function showCountResult(data) {
            if (!countValueEl) return;
            var total       = data.total || 0;
            var exportCount = data.exportCount != null ? data.exportCount : total;
            lastCount = exportCount;

            if (total === 0) {
                countValueEl.textContent = 'No orders match your filters.';
                countValueEl.className = 'acc-order-count__value';
                if (startBtn) startBtn.disabled = true;
                return;
            }

            countValueEl.textContent = fmtNum(total) + ' orders match your filters';
            countValueEl.className = 'acc-order-count__value';

            if (maxEl && maxEl.value && exportCount < total && countExportEl) {
                countExportEl.textContent = fmtNum(exportCount) + ' orders will be exported (max count applied)';
                countExportEl.style.display = 'block';
            } else if (countExportEl) {
                countExportEl.style.display = 'none';
            }

            if (startBtn) startBtn.disabled = exportCount === 0;
        }

        function fetchOrderCount() {
            if (!cfg.countUrl) return;
            showCountLoading();
            if (countBtn) countBtn.disabled = true;
            post(cfg.countUrl, getFilterParams(), function (data) {
                if (countBtn) countBtn.disabled = false;
                if (!data.ok) {
                    if (countValueEl) {
                        countValueEl.textContent = 'Unable to count orders' + (data.error ? ': ' + data.error : '');
                        countValueEl.className = 'acc-order-count__value';
                    }
                    return;
                }
                showCountResult(data);
            });
        }

        function renderAttrResults(missing, mapped, coveragePending, skipped, suggested, aiMeta) {
            if (!attrResults) return;
            if (!window.AccAttrPreflight || !window.AccAttrPreflight.renderMissingResults) {
                attrResults.innerHTML = '<p style="color:#c62828;font-size:13px;margin:0;">Attribute helper script failed to load.</p>';
                attrResults.style.display = 'block';
                return;
            }
            window.AccAttrPreflight.renderMissingResults({
                container:       attrResults,
                mapped:          mapped || [],
                coveragePending: coveragePending || [],
                skipped:         skipped || [],
                suggested:       suggested || [],
                aiStatus:           (aiMeta && aiMeta.aiStatus) || 'skipped',
                aiMessage:          (aiMeta && aiMeta.aiMessage) || '',
                suggestAttrMapsUrl: (aiMeta && aiMeta.suggestAttrMapsUrl) || '',
                taskName:           (aiMeta && aiMeta.taskName) || '',
                sfccObjectType:     (aiMeta && aiMeta.sfccObjectType) || '',
                sessionSystemMaps: (aiMeta && aiMeta.sessionSystemMaps) || [],
                missing:            missing,
                ui:                 ui,
                createAttrsUrl:     cfg.createAttrsUrl,
                clearAttrMapUrl:    cfg.clearAttrMapUrl || '',
                post:            post,
                getPending:      function () { return pendingMissing; }
            });
        }

        function finalizeFull(success, uploadedFile) {
            fullRunning = false;
            if (startBtn) startBtn.disabled = false;
            if (success) {
                fullFinished = true;
                if (startBtn) startBtn.textContent = 'Finish';
                var importDetail = (uploadedFile || 'Order XML') + ' is ready in IMPEX. Import via Site Development.';
                setPhase('full', 'import', 'active', importDetail, null);
            } else {
                fullFinished = false;
                if (startBtn) startBtn.textContent = 'Start Migration (Build XML)';
            }
        }

        function beginMigration() {
            if (!lastCount) {
                fetchOrderCount();
                return;
            }

            fullRunning = true;
            if (startBtn) {
                startBtn.disabled = true;
                startBtn.textContent = 'Building...';
            }
            if (fullPhaseList) fullPhaseList.style.display = 'block';
            setPhase('full', 'build', 'active', 'Streaming orders to IMPEX...', 25);
            setPhase('full', 'import', 'pending', 'Waiting for Phase 1…', 0);

            var filters = getFilterParams();
            // Each request exports up to 1,000 orders into part files and returns its state;
            // send the state back until the server reports done.
            function exportNext(state) {
                var body = filters + (state ? '&state=' + encodeURIComponent(JSON.stringify(state)) : '');
                post(cfg.exportUrl, body, function (data) {
                    if (!data.ok) {
                        var msg = (data.error || 'Failed') + (state ? ' (after ' + fmtNum(state.processed) + ' orders; start again for a complete export)' : '');
                        setPhase('full', 'build', 'error', msg, 0);
                        if (fullOverallEl) fullOverallEl.textContent = data.error || 'Build failed';
                        finalizeFull(false);
                        return;
                    }
                    // continue only when the server hands back a state to resume from
                    if (!data.done && data.state) {
                        var pct = data.total ? Math.min(99, Math.round(data.processed * 100 / data.total)) : 50;
                        setPhase('full', 'build', 'active', fmtNum(data.processed) + ' of ' + fmtNum(data.total)
                            + ' orders processed, ' + (data.files || []).length + ' file(s)', pct);
                        exportNext(data.state);
                        return;
                    }
                    showBuildResult(data);
                });
            }
            exportNext(null);
        }

        function showBuildResult(data) {
            var report = data.report || {};
            var built  = report.ordersValidated || data.built || 0;
            var failed = report.ordersFailed || data.failed || 0;
            var buildState = 'done';
            if (failed > 0 && built === 0) buildState = 'error';
            else if (failed > 0) buildState = 'warning';

            var files = data.files || [];
            var buildDetail = fmtNum(built) + ' order(s) written';
            if (failed > 0) buildDetail += ', ' + fmtNum(failed) + ' failed validation';
            if (data.productsNotFound > 0) {
                buildDetail += ', ' + fmtNum(data.productsNotFound)
                    + ' line item(s) with no matching SFCC product (SKU kept)';
            }
            if (files.length) buildDetail += ' — ' + files.length + ' file(s): ' + files.join(', ');

            setPhase('full', 'build', buildState, buildDetail, 100);
            if (fullOverallEl) {
                fullOverallEl.textContent = fmtNum(built) + ' validated, ' + fmtNum(failed) + ' failed';
            }
            finalizeFull(true, files.length > 1 ? files.length + ' order XML files' : files[0]);
        }

        if (yearsEl) yearsEl.addEventListener('change', showCountIdle);
        if (stateEl) stateEl.addEventListener('change', showCountIdle);
        if (payEl) payEl.addEventListener('change', showCountIdle);
        if (maxEl) maxEl.addEventListener('input', showCountIdle);
        if (customersEl) customersEl.addEventListener('input', showCountIdle);

        if (countBtn) {
            countBtn.addEventListener('click', function (e) {
                e.preventDefault();
                fetchOrderCount();
            });
        }

        if (startBtn) {
            startBtn.disabled = true;
            startBtn.addEventListener('click', function () {
                if (fullFinished) {
                    if (cfg.dataWizardEntryUrl) window.location.href = cfg.dataWizardEntryUrl;
                    return;
                }
                if (fullRunning) return;
                beginMigration();
            });
        }

        if (checkAttrsBtn) {
            checkAttrsBtn.addEventListener('click', function () {
                checkAttrsBtn.disabled = true;
                checkAttrsBtn.textContent = ui.attrCheckingBtn || 'Checking...';
                if (attrCheckMsg) attrCheckMsg.textContent = '';
                get(cfg.checkAttrsUrl, function (data) {
                    checkAttrsBtn.disabled = false;
                    checkAttrsBtn.textContent = ui.attrRecheckBtn || 'Re-check';
                    if (!data.ok) {
                        if (attrCheckMsg) {
                            attrCheckMsg.textContent = 'Error: ' + (data.error || 'Check failed');
                            attrCheckMsg.style.color = '#c62828';
                        }
                        return;
                    }
                    pendingMapped = data.mapped || [];
                    pendingCoverage = data.coveragePending || [];
                    pendingSkipped = data.skipped || [];
                    pendingMissing = data.missing || [];
                    if (attrCheckMsg) {
                        var parts = [];
                        if (pendingMapped.length) parts.push(pendingMapped.length + ' mapped');
                        if (pendingMissing.length) parts.push(pendingMissing.length + (ui.attrsMissingBrief || ' to create.'));
                        if (pendingCoverage.length) parts.push(pendingCoverage.length + ' SFCC pending');
                        if (pendingSkipped.length) parts.push(pendingSkipped.length + ' skipped');
                        attrCheckMsg.textContent = parts.length
                            ? parts.join(', ')
                            : (ui.attrsAllInSync || 'All in sync.');
                        attrCheckMsg.style.color = pendingMissing.length ? '#e65100' : '#2e7d32';
                    }
                    renderAttrResults(pendingMissing, pendingMapped, pendingCoverage, pendingSkipped, data.suggested || [], data);
                });
            });
        }

        showCountIdle();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
}());
