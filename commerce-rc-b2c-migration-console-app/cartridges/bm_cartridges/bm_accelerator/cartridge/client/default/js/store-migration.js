/**
 * Store migration — selectable source stores/locations export to SFCC IMPEX.
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
        var root = document.getElementById('acc-st-root');
        if (!root) return { ui: {} };
        return {
            fullBatchUrl:       root.getAttribute('data-full-batch-url') || '',
            listStoresUrl:      root.getAttribute('data-list-stores-url') || '',
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

    function parseJsonResponse(raw, fallbackError) {
        if (!raw || !String(raw).trim()) {
            return { ok: false, error: fallbackError || 'Empty response from server' };
        }
        try {
            return JSON.parse(raw);
        } catch (e) {
            var snippet = String(raw).replace(/\s+/g, ' ').substring(0, 180);
            return {
                ok:    false,
                error: 'Server returned non-JSON (session timeout?). ' + snippet
            };
        }
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
            onDone(parseJsonResponse(req.responseText, 'Parse error'));
        };
        req.onerror = function () { onDone({ ok: false, error: 'Network error' }); };
        req.send(null);
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
            onDone(parseJsonResponse(req.responseText, 'Parse error'));
        };
        req.onerror = function () { onDone({ ok: false, error: 'Network error' }); };
        req.send(params);
    }

    function todayStamp() {
        var d = new Date();
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
    }

    function defaultFileName() {
        return 'store-full-' + todayStamp() + '-v001.xml';
    }

    function boot() {
        var cfg = readCfg();
        var ui  = cfg.ui || {};
        var clearAttrMapOnLeave = (window.AccAttrPreflight && window.AccAttrPreflight.bindClearOnLeave)
            ? window.AccAttrPreflight.bindClearOnLeave(cfg.clearAttrMapUrl, 'Accelerator-StoreMigration')
            : null;
        var loadingEl = document.getElementById('acc-st-loading');
        var errorEl = document.getElementById('acc-st-error');
        var tableWrap = document.getElementById('acc-st-table-wrap');
        var tbody = document.getElementById('acc-st-tbody');
        var summaryEl = document.getElementById('acc-st-summary');
        var selectAll = document.getElementById('acc-st-select-all');
        var selectionErr = document.getElementById('acc-st-selection-error');
        var fileWrap = document.getElementById('acc-st-file-wrap');
        var fileNameEl = document.getElementById('acc-st-file-name');
        var reloadBtn = document.getElementById('acc-reload-stores-btn');
        var startBtn = document.getElementById('full-start-btn');
        var fullOverallEl = document.getElementById('full-move-overall');
        var fullPhaseList = document.getElementById('full-phase-list');
        var checkAttrsBtn = document.getElementById('acc-check-attrs-btn');
        var attrCheckMsg = document.getElementById('acc-attr-check-msg');
        var attrResults = document.getElementById('acc-attr-results');
        var idSourceEl = document.getElementById('acc-st-id-source');

        var ctpStores = [];
        var idSource = '';
        var fileName = defaultFileName();
        var fullRunning = false;
        var fullFinished = false;
        var pendingMissing = [];
        var pendingMapped = [];
        var pendingCoverage = [];
        var pendingSkipped = [];

        function setPhase(prefix, id, state, detail, pct) {
            var li  = document.getElementById(prefix + '-phase-' + id);
            var st  = document.getElementById(prefix + '-status-' + id);
            var det = document.getElementById(prefix + '-detail-' + id);
            var bar = document.getElementById(prefix + '-bar-' + id);
            if (!li) return;
            li.className = 'acc-phases__item acc-phases__item--' + state;
            if (st)  st.textContent = state;
            if (det && detail !== null) det.textContent = detail || '';
            if (bar) bar.style.width = (pct || 0) + '%';
        }

        function getSelectedStoreRefs() {
            var refs = [];
            var cbs = document.querySelectorAll('.acc-st-store-cb');
            var i;
            for (i = 0; i < cbs.length; i++) {
                if (cbs[i].checked) {
                    refs.push(cbs[i].getAttribute('data-ref'));
                }
            }
            return refs;
        }

        /** Store type chosen per selected store: ref → physical | online. */
        function getSelectedStoreTypes() {
            var types = {};
            var cbs = document.querySelectorAll('.acc-st-store-cb');
            var i;
            for (i = 0; i < cbs.length; i++) {
                if (!cbs[i].checked) continue;
                var sel = document.querySelector('.acc-st-type[data-idx="' + cbs[i].getAttribute('data-idx') + '"]');
                types[cbs[i].getAttribute('data-ref')] = sel ? sel.value : 'physical';
            }
            return types;
        }

        function updateSelectionSummary() {
            var types = getSelectedStoreTypes();
            var refs = Object.keys(types);
            var physical = 0;
            var i;
            for (i = 0; i < refs.length; i++) {
                if (types[refs[i]] === 'physical') physical++;
            }
            var online = refs.length - physical;
            var total = ctpStores.length;
            if (summaryEl) {
                summaryEl.textContent = total
                    ? physical + ' physical store(s) will be exported'
                        + (online ? ', ' + online + ' online store(s) skipped' : '')
                        + ' (' + refs.length + ' of ' + total + ' selected)'
                    : '';
                summaryEl.style.color = physical ? '#2e7d32' : '#e65100';
            }
            if (startBtn && total && !fullRunning && !fullFinished) {
                startBtn.disabled = !physical;
            }
        }

        function renderIssues(issues, type) {
            if (type !== 'physical') {
                return '<span style="color:#8a9ab8;">Not exported as a store: an online store (sales channel) belongs to the site setup</span>';
            }
            var list = issues || [];
            if (!list.length) return '<span style="color:#2e7d32;">&#10004; No problems found</span>';
            var html = '';
            var i;
            for (i = 0; i < list.length; i++) {
                var err = list[i].level === 'error';
                html += '<div style="color:' + (err ? '#c62828' : '#b26a00') + ';">' + (err ? '&#10006; ' : '&#9888; ')
                    + escHtml(list[i].message) + '</div>';
            }
            return html;
        }

        function refreshRow(idx) {
            var s = ctpStores[idx];
            var sel = document.querySelector('.acc-st-type[data-idx="' + idx + '"]');
            var cell = document.getElementById('acc-st-checks-' + idx);
            if (s && sel && cell) cell.innerHTML = renderIssues(s.issues, sel.value);
        }

        function renderStoresTable(stores) {
            ctpStores = stores || [];
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) errorEl.style.display = 'none';
            if (selectionErr) selectionErr.style.display = 'none';

            if (!ctpStores.length) {
                if (errorEl) {
                    errorEl.style.display = 'block';
                    errorEl.textContent = ui.noStores || 'No stores found.';
                }
                if (tableWrap) tableWrap.style.display = 'none';
                if (fileWrap) fileWrap.style.display = 'none';
                if (startBtn) startBtn.disabled = true;
                updateSelectionSummary();
                return;
            }

            var html = '';
            var i;
            for (i = 0; i < ctpStores.length; i++) {
                var s = ctpStores[i];
                var type = s.suggestedType === 'online' ? 'online' : 'physical';
                html += '<tr class="st-stores-row" data-idx="' + i + '">'
                    + '<td style="text-align:center;"><input type="checkbox" class="acc-st-store-cb" data-ref="'
                    + escHtml(s.ref) + '" data-idx="' + i + '" checked/></td>'
                    + '<td>' + escHtml(s.name)
                    + (s.address ? '<div style="font-size:11px;color:#8a9ab8;">' + escHtml(s.address) + '</div>' : '') + '</td>'
                    + '<td>' + (s.key ? '<code>' + escHtml(s.key) + '</code>' : '<span style="color:#8a9ab8;">&mdash;</span>') + '</td>'
                    + '<td><select class="acc-st-type" data-idx="' + i + '" title="' + escHtml('Suggested: ' + (s.typeReasons || []).join('; ')) + '">'
                    + '<option value="physical"' + (type === 'physical' ? ' selected' : '') + '>Physical store</option>'
                    + '<option value="online"' + (type === 'online' ? ' selected' : '') + '>Online store (sales channel)</option>'
                    + '</select></td>'
                    + '<td><code>' + escHtml(s.sfccStoreId) + '</code></td>'
                    + '<td style="font-size:12px;color:#54698d;">' + (s.countries ? escHtml(s.countries) : '&mdash;') + '</td>'
                    + '<td style="font-size:12px;" id="acc-st-checks-' + i + '">' + renderIssues(s.issues, type) + '</td>'
                    + '</tr>';
            }

            if (tbody) tbody.innerHTML = html;
            if (tableWrap) tableWrap.style.display = 'block';
            if (fileWrap) fileWrap.style.display = 'block';
            if (fileNameEl) fileNameEl.textContent = fileName;

            if (selectAll) {
                selectAll.checked = true;
                selectAll.onchange = function () {
                    var cbs = document.querySelectorAll('.acc-st-store-cb');
                    var c;
                    for (c = 0; c < cbs.length; c++) {
                        cbs[c].checked = selectAll.checked;
                        var row = cbs[c].closest('tr');
                        if (row) {
                            row.className = selectAll.checked ? 'st-stores-row' : 'st-stores-row st-stores-row--skipped';
                        }
                    }
                    updateSelectionSummary();
                };
            }

            var storeCbs = document.querySelectorAll('.acc-st-store-cb');
            for (i = 0; i < storeCbs.length; i++) {
                storeCbs[i].addEventListener('change', function () {
                    var row = this.closest('tr');
                    if (row) {
                        row.className = this.checked ? 'st-stores-row' : 'st-stores-row st-stores-row--skipped';
                    }
                    var all = document.querySelectorAll('.acc-st-store-cb');
                    var checkedCount = 0;
                    var a;
                    for (a = 0; a < all.length; a++) {
                        if (all[a].checked) checkedCount++;
                    }
                    if (selectAll) {
                        selectAll.checked = checkedCount === all.length;
                        selectAll.indeterminate = checkedCount > 0 && checkedCount < all.length;
                    }
                    updateSelectionSummary();
                });
            }

            var typeSels = document.querySelectorAll('.acc-st-type');
            for (i = 0; i < typeSels.length; i++) {
                typeSels[i].addEventListener('change', function () {
                    refreshRow(parseInt(this.getAttribute('data-idx'), 10));
                    updateSelectionSummary();
                });
            }

            updateSelectionSummary();
        }

        function loadStores(fromUserClick) {
            if (!cfg.listStoresUrl) {
                if (loadingEl) loadingEl.style.display = 'none';
                if (errorEl) {
                    errorEl.style.display = 'block';
                    errorEl.textContent = 'Store list API URL is missing. Hard-refresh the page (Ctrl+Shift+R).';
                }
                return;
            }

            if (loadingEl) {
                loadingEl.style.display = 'block';
                loadingEl.textContent = fromUserClick
                    ? (ui.reloadingStores || 'Reloading...')
                    : (ui.loadingStores || 'Loading stores...');
            }
            if (errorEl) errorEl.style.display = 'none';
            if (tableWrap) tableWrap.style.display = 'none';
            if (fileWrap) fileWrap.style.display = 'none';
            if (startBtn) startBtn.disabled = true;
            if (reloadBtn) {
                reloadBtn.disabled = true;
                reloadBtn.textContent = 'Loading...';
            }

            var listUrl = cfg.listStoresUrl;
            if (idSource) {
                listUrl += (listUrl.indexOf('?') === -1 ? '?' : '&') + 'idSource=' + encodeURIComponent(idSource);
            }
            get(listUrl, function (data) {
                if (reloadBtn) {
                    reloadBtn.disabled = false;
                    reloadBtn.textContent = 'Reload Stores';
                }
                if (data.ok && data.idSource) {
                    idSource = data.idSource;
                    if (idSourceEl) idSourceEl.value = data.idSource;
                }
                if (!data.ok) {
                    if (loadingEl) loadingEl.style.display = 'none';
                    if (errorEl) {
                        errorEl.style.display = 'block';
                        errorEl.textContent = 'Failed to load: ' + (data.error || 'Unknown error');
                    }
                    ctpStores = [];
                    updateSelectionSummary();
                    return;
                }
                fileName = defaultFileName();
                renderStoresTable(data.stores || []);
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
                aiStatus:        (aiMeta && aiMeta.aiStatus) || 'skipped',
                aiMessage:       (aiMeta && aiMeta.aiMessage) || '',
                suggestAttrMapsUrl: (aiMeta && aiMeta.suggestAttrMapsUrl) || '',
                taskName:           (aiMeta && aiMeta.taskName) || '',
                sfccObjectType:     (aiMeta && aiMeta.sfccObjectType) || '',
                sessionSystemMaps: (aiMeta && aiMeta.sessionSystemMaps) || [],
                missing:         missing,
                ui:              ui,
                createAttrsUrl:  cfg.createAttrsUrl,
                clearAttrMapUrl: cfg.clearAttrMapUrl || '',
                post:            post,
                getPending:      function () { return pendingMissing; }
            });
        }

        function finalizeFull(success, uploadedFile) {
            fullRunning = false;
            if (success) {
                fullFinished = true;
                if (startBtn) {
                    startBtn.textContent = 'Finish';
                    startBtn.disabled = false;
                }
                var importDetail = 'Uploaded ' + (uploadedFile || fileName) + ' to /Impex/' + cfg.impexPath + '/. Import stores in Business Manager.';
                setPhase('full', 'import', 'active', importDetail, null);
            } else {
                fullFinished = false;
                if (startBtn) startBtn.textContent = 'Start Migration (Build XML)';
                updateSelectionSummary();
            }
        }

        function beginMigration() {
            var keys = getSelectedStoreRefs();
            var types = getSelectedStoreTypes();
            if (!keys.length) {
                if (selectionErr) {
                    selectionErr.style.display = 'block';
                    selectionErr.textContent = 'Select at least one store to migrate.';
                }
                if (startBtn) startBtn.disabled = false;
                return;
            }
            if (selectionErr) selectionErr.style.display = 'none';

            fullRunning = true;
            if (startBtn) {
                startBtn.disabled = true;
                startBtn.textContent = 'Building...';
            }
            if (fullPhaseList) fullPhaseList.style.display = 'block';
            setPhase('full', 'build', 'active', 'Building store XML for ' + keys.length + ' store(s)...', 50);
            setPhase('full', 'import', 'pending', null, 0);

            post(
                cfg.fullBatchUrl,
                'offset=0'
                + '&exportKey=full'
                + '&fileName=' + encodeURIComponent(fileName)
                + '&keys=' + encodeURIComponent(JSON.stringify(keys))
                + '&types=' + encodeURIComponent(JSON.stringify(types))
                + '&idSource=' + encodeURIComponent(idSource || ''),
                function (data) {
                    if (!data.ok) {
                        setPhase('full', 'build', 'error', data.error || 'Failed', 50);
                        if (fullOverallEl) fullOverallEl.textContent = data.error || 'Build failed';
                        finalizeFull(false);
                        return;
                    }
                    var uploaded = data.fileName || fileName;
                    setPhase('full', 'build', 'done',
                        'Uploaded ' + uploaded + ' (' + (data.built || 0) + ' store(s))', 100);
                    if (fullOverallEl) {
                        fullOverallEl.textContent = (data.built || 0) + ' store(s) written, ' + (data.failed || 0) + ' failed'
                            + (data.online ? ', ' + data.online + ' online store(s) skipped' : '')
                            + (data.warnings ? ', ' + data.warnings + ' warning(s) (see Checks)' : '')
                            + (data.errors && data.errors.length ? ' — ' + data.errors.join('; ') : '');
                    }
                    finalizeFull(true, uploaded);
                }
            );
        }

        if (reloadBtn) {
            reloadBtn.addEventListener('click', function () {
                loadStores(true);
            });
        }

        if (idSourceEl) {
            idSourceEl.addEventListener('change', function () {
                idSource = idSourceEl.value;
                if (ctpStores.length) loadStores(true);
            });
        }

        if (loadingEl) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = ui.loadStoresHint || 'Click Load Stores to fetch stores.';
        }
        if (tableWrap) tableWrap.style.display = 'none';
        if (fileWrap) fileWrap.style.display = 'none';

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
                        attrCheckMsg.textContent = parts.length
                            ? parts.join(', ')
                            : (ui.attrsAllInSync || 'All in sync.');
                        attrCheckMsg.style.color = pendingMissing.length ? '#e65100' : '#2e7d32';
                    }
                    renderAttrResults(pendingMissing, pendingMapped, pendingCoverage, pendingSkipped, data.suggested || [], data);
                });
            });
        }

        if (startBtn) {
            startBtn.addEventListener('click', function () {
                if (fullFinished) {
                    if (clearAttrMapOnLeave) clearAttrMapOnLeave();
                    window.location.href = cfg.dataWizardEntryUrl;
                    return;
                }
                if (fullRunning) return;
                fullFinished = false;
                startBtn.disabled = true;
                beginMigration();
            });
        }

    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
}());
