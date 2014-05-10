﻿DataExplorer.QueryEditor = (function () {
    var editor, field, query,
        options = {
            'mode': 'text/x-t-sql'
        };

    function exists() {
        return !!editor || !!query;
    }

    function create(target, callback) {
        if (typeof target === 'string') {
            target = $(target);
        }

        if (!target.length) {
            return;
        }

        field = target;
        target = target[0];

        if (target.nodeName === 'TEXTAREA') {
            function run() {
                field.closest('form').submit();
            }

            editor = CodeMirror.fromTextArea(target, $.extend({}, options, {
                'lineNumbers': true,
                'extraKeys': {
                    'Ctrl-Enter': run,
                    'F5': run
                }
            }));
        } else {
            query = target[_textContent];
            editor = CodeMirror.runMode(query, options.mode, target);
        }

        if (callback && typeof callback === 'function') {
            callback(editor);
        }
    }

    function getValue() {
        if (!exists()) {
            return null;
        }

        if (query) {
            return query;
        }   

        var value = editor.getValue();

        // Strip zero-width that randomly appears when copying text from the current
        // Data Explorer query editor into this one, at least until I can figure out
        // where it's coming from.
        if (value.charCodeAt(value.length - 1) === 8203) {
            value = value.substring(0, value.length - 1);
        }

        // Explicitly update the field, since CodeMirror might not have gotten a
        // chance to yet
        field.val(value);

        return value;
    }

    return {
        'create': create,
        'value': getValue,
        'exists': exists
    };
})();

DataExplorer.ready(function () {
    var schema = $('#schema'),
        history = $('#history'),
        panel = $('#editor-panel'),
        metadata = $('#query-metadata .info'),
        gridOptions = {
            'enableCellNavigation': false,
            'enableColumnReorder': false,
            'enableCellRangeSelection': false
        },
        error = $('#error-message'),
        form = $('#runQueryForm');

    DataExplorer.QueryEditor.create('#queryBodyText');
    DataExplorer.QueryEditor.create('#sql', function (editor) {
        var wrapper;

        DataExplorer.Sidebar.init({
            editorTheme: editor.getOption('theme'),
            panel: panel,
            toolbar: '#editor-toolbar'
        });

        if (editor) {
            wrapper = $(editor.getScrollerElement());
        }

        function resizePanel(available) {
            var remaining = available - history.outerHeight(),
                list = schema.children('ul'),
                offset = schema.outerHeight() - list.height();

            list.height(remaining - offset);
            DataExplorer.TableHelpers.resize((available - offset) + 9);

            if (wrapper) {
                offset = wrapper.closest('.CodeMirror').outerHeight() - wrapper.height();
                
                wrapper.height(available - offset);
                editor.refresh();
            }
        }

        // Set this resizer up after because the grippie adds height to the
        // sidebar that we need to factor in
        $('#editor').TextAreaResizer(resizePanel, { 
            'useParentWidth': true,
            'resizeWrapper': true,
            'minHeight': 300,
            'initCallback': true
        });
    });

    $('.miniTabs').tabs(false);

    form.submit(function () {
        $('.report-option').hide();
        error.hide();

        var cleanup = function () {
            $('#loading').hide();

            form.find('input, button').prop('disabled', function () {
                return this.id == 'cancel-query';
            });
        };

        var fail = function() {
            showError({ 'error': "Something unexpected went wrong while running "
                            + "your query. Don't worry, blame is already being assigned." });
        };

        var cancel = function () {
            showError({ 'error': 'Query execution has been cancelled' }, 'notice');
        }

        var pending = { request: null, timeout: null, setupCancel: true };
        var success = function(response) {
            if (response.running === true)
            {
                var poll = function () {
                    pending.timeout = setTimeout(function(){
                        pending.request = $.ajax({
                            'type': 'GET',
                            'url': '/query/job/' + response.job_id,
                            'success': success,
                            'error': [cleanup, fail],
                            'cache': false
                        });  
                    }, 1500);
                };

                if (!pending.timeout && pending.setupCancel) {
                    var job = response.job_id;
                    pending.setupCancel = false;

                    $('#cancel-query').one('click', function () {
                        this.disabled = true;

                        clearTimeout(pending.timeout);

                        if (pending.request) {
                            pending.request.abort();
                        }

                        $.ajax({
                            type: 'POST',
                            url:  '/query/job/' + job + '/cancel',
                            success: function (response) {
                                if (response.cancelled) {
                                    cleanup();
                                    cancel();
                                } else {
                                    // There were some results, so we're going to try and get whatever
                                    // was being returned when the user decided to cancel
                                    poll();
                                }
                            },
                            error: [cleanup, fail],
                            cache: false
                        });
                    }).prop('disabled', false);
                }

                poll();
            }
            else 
            {
                cleanup();
                parseQueryResponse(response);
            }
        };

        if (verifyParameters()) {
            var data = form.serialize();
            form.find('input, button').prop('disabled', true);
            
            $('#loading').show();
            
            $.ajax({
                'type': 'POST',
                'url': this.action,
                'data': data,
                'success': success,
                'error': [cleanup, fail],
                'cache': false,
            });
        }

        return false;
    });

    $('#query-options').find('input, select').each(function () {
        var value = window.location.param('opt.' + this.name);

        if (value) {
            if (this.type === 'checkbox') {
                this.checked = value;
            } else {
                this.value = value;
            }
        }
    });

    $('#query-results').bind('show', function (event) {
        $('.download-button', this).hide();
        $(event.target.href.from('#') + 'Button').show();
    });

    $('#executionPlanTab').click(function () {
        QP.drawLines();
    });
    $(window).resize(resizeResults);

    function resizeResults() {
        var defaultWidth = document.getElementById('query').clientWidth - 2,
            availableWidth = document.documentElement.clientWidth - 100,
            grid = $('#resultSets'),
            gridWidth = grid.outerWidth(),
            canvas = grid.find('.grid-canvas'),
            canvasWidth = canvas.outerWidth(),
            width = 0;

        if (canvasWidth < defaultWidth || availableWidth < defaultWidth) {
            grid.width(width = defaultWidth);
        } else if (canvasWidth > availableWidth) {
            grid.width(width = availableWidth);
        } else {
            grid.width(width = canvasWidth);
        }

        if (width === defaultWidth) {
            grid.css('left', '0px');
        } else {
            grid.css('left', '-' + Math.round((width - defaultWidth) / 2) + 'px');
        }
    }

    // Ideally we can separate out the actual displaying bits so that the user
    // doesn't have to click the button before getting the form.
    function verifyParameters() {
        var sql = null;
        
        // Ugh, this is ugly, need to rework this soon
        if (DataExplorer.QueryEditor.exists()) {
            sql = DataExplorer.QueryEditor.value();
        } else {
            // This is a pretty big assumption
            sql = $('#queryBodyText').text();
        }

        if (!sql) {
            return false;
        }

        var parameters = new DataExplorer.ParameterParser.parse(sql, {
            multilineStrings: true,
            multilineComments: true,
            stringEscapeCharacter: "'",
            nestedMultilineComments: true
        });

        var complete = true,
            wrapper = document.getElementById('query-params'),
            fieldList = wrapper.getElementsByTagName('input'),
            fields = {},
            field, name, label, row, value, hasValue, key, first;

        $(wrapper).toggle(!!parameters.length);

        for (var i = fieldList.length - 1; i > -1 ; --i) {
            field = fieldList.item(i);
            value = field.getAttribute('value');
            name = field.name;

            if (field.value && field.value.length /*&& value != field.value*/) {
                fields[name] = field.value; 
            }

            field.parentNode.parentNode.removeChild(field.parentNode);
        }

        for (var i = 0; i < parameters.length; ++i) {
            label = document.createElement('label');
            label.htmlFor = 'dynParam' + i;
            label[_textContent] = parameters[i].label || parameters[i].name;
            
            if (parameters[i].description) {
                label.title = parameters[i].description;
            }

            value = fields[parameters[i].name];
            hasValue = !(!value && value !== 0);

            if (!hasValue) {
                value = window.location.param(parameters[i].name);
                hasValue = !(!value && value !== 0);
            }

            if (!hasValue) {
                value = parameters[i].auto;
                hasValue = !(!value && value !== 0);
            }

            if (!hasValue && parameters[i].name.toLowerCase() === 'userid') {
                if (DataExplorer.options.User.isAuthenticated && DataExplorer.options.User.guessedID) {
                    hasValue = true;
                    value = DataExplorer.options.User.guessedID;
                }
            }

            if (complete) {
                complete = hasValue;
            }

            field = document.createElement('input');
            field.name = parameters[i].name;
            field.id = 'dynParam' + i;
            field.type = 'text';

            if (hasValue) {
                field.setAttribute('value', value);
            } else if (!first) {
                first = field;
            }

            row = document.createElement('div');
            row.className = 'form-row';
            row.appendChild(label);
            row.appendChild(field);

            wrapper.appendChild(row);
        }

        if (!complete && first) {
            first.focus();
        }

        return complete;
    }

    function parseQueryResponse(response) {
        if (showError(response) || showCaptcha(response)) {
            return;
        }

        var action = form[0].action, records = 0,
            results, height = 0, maxHeight = 500,
            slug = response.slug,
            params = $('#query-params input[type="text"]').serialize(),
            textOnly = false,
            userid;

        if (params) {
            params = params.replace(/(^|&)UserId=(\d+)(&|$)/i, function (match, g1, g2, g3) {
                userid = g2;

                return g1 ? g3 : "";
            });

            if (params.length) {
                params = '?' + params;
            } else {
                params = null;
            }
        }

        if (/[^\d]\/\d+$/.test(action)) {
            form[0].action = action + '/' + response.querySetId;
        }

        if (response.resultSets.length) {
            results = response.resultSets[0];
            records = results.rows.length;
        } else {
            textOnly = true;
            response.resultSets = null;
        }

        document.getElementById('messages').children[0][_textContent] = response.messages;

        if (!slug && !/\/[^\/]+\/query\/new/.test(window.location.pathname) && /.*?\/[^\/]+$/.test(window.location.pathname)) {
            slug = window.location.pathname.substring(window.location.pathname.lastIndexOf('/'));

            if (/\d+/.test(slug)) {
                slug = null;
            }
        } else if (slug && slug.indexOf('/') !== 0) {
            slug = '/' + slug;
        }

        DataExplorer.template('#execution-stats', 'text', {
            'records': textOnly ? "Results" : records + " rows",
            'time': response.executionTime === 0 ? "<1" : response.executionTime,
            'cached': response.fromCache ? ' (cached)' : ''
        });

        var target = "";
        if (response.targetSites == 1) { target = "all-"; } // all sites
        else if (response.targetSites == 2) { target = "all-meta-"; } // all meta sites
        else if (response.targetSites == 3) { target = "all-non-meta-"; } // all non meta sites
        else if (response.targetSites == 4) { target = "all-meta-but-mse-"; } // all meta sites except mse
        else if (response.targetSites == 5) { target = "all-non-meta-but-so-"; } // all non meta sites except so
        
        var options;

        $('#query-options').find('input, select').each(function () {
            var value;

            if (this.type === 'checkbox') {
                if (this.checked) {
                    value = true;
                }
            } else {
                value = this.value;

                // If this is a select and the selected option is set in the HTML as the default one,
                // there's no sense in appending it to the query string
                if (this.tagName == 'SELECT' && this.options[this.selectedIndex].getAttribute('selected') !== null) {
                    value = null;
                }
            }

            if (value) {
                options = (options ? options + '&' : '') + 'opt.' + this.name + '=' + encodeURIComponent(value);
            }
        });

        if (options) {
            params = (params ? params + '&' : '?') + options;
        }

        var formatOptions = {
            'targetsites': target,
            'site': response.siteName,
            'revisionid': response.revisionId,
            'slug': slug,
            'params': params,
            'id' : response.querySetId
        };

        DataExplorer.template('a.templated.site', 'href', formatOptions);
        DataExplorer.SiteSwitcher.update(formatOptions);

        if (userid) {
            formatOptions.params = (params ? params + '&' : '?') + 'UserId=' + userid;
        }

        DataExplorer.template('a.templated:not(.site), a.templated.related-site', 'href', formatOptions);

        if (DataExplorer.Sidebar) {
            DataExplorer.Sidebar.updateHistory(response);
        }

        response.graph = !textOnly && DataExplorer.Graph.isGraph(results);

        $('#query-results .miniTabs a.optional').each(function () {
            $(this).toggleClass('hidden', !response[this.hash.substring(1)]);
        });

        // We have to start showing the contents so that SlickGrid can figure
        // out the heights of its components correctly
        $('.result-option').fadeIn('fast').promise().done(function () {
            var tabset = $('#query-results .miniTabs a').off('show'),
                firstTab = tabset.filter(':not(.hidden):first'),
                selectedTab;

            if (window.location.hash) {
                selectedTab = $(window.location.hash + 'Tab');

                if (!selectedTab.length || selectedTab.hasClass('hidden')) {
                    selectedTab = null;
                }
            }
            
            if (response.graph) {
                var graph = new DataExplorer.Graph(results, '#graph');

                tabset.on('show', function (event, panel) {
                    if (panel === '#graph' && !graph.isInitialized()) {
                        graph.show();
                    }
                });
            }

            var permalink = $('#permalink a')[0];

            if (permalink) {
                tabset.off('click.permalink');
                tabset.on('click.permalink', function () {
                    // We should probably be using the formatter here, but for now we'll
                    // just hack around it because this whole mess needs tidying anyway
                    permalink.href = permalink.href.replace(/#.*$/, '') + (this != firstTab[0] ? this.hash : '');
                });
            }

            firstTab.click();

            if (response.executionPlan && QP && typeof QP.drawLines === 'function') {
                $('#executionPlan').html(response.executionPlan);
            }

            if (!textOnly) {
                prepareTable($('#resultSets'), results, response);
                resizeResults();
            }

            if (selectedTab && selectedTab[0] != firstTab[0]) {
                selectedTab.click();
            }
        
            // Currently this always gives us 500 because it's what #resultset has
            // set in CSS. SlickGrid needs the explicit height to render correctly
            // though, so once we figure out how to resize #resultset dynamically
            // then this will be a bit more useful.
            $('#query-results .panel').each(function () {
                var currentHeight = $(this).height();

                if (currentHeight >= maxHeight) {
                    height = maxHeight;
                    return false;
                }

                height = Math.max(currentHeight, height);
            }).animate({ 'height': Math.min(height, maxHeight) });

            $('html, body').animate({
                scrollTop: $("#query-results").offset().top - 10
            }, 500);
        });
    }

    // Temporary workaround
    window.loadCachedResults = function (cache) {
        verifyParameters();

        if (cache) {
            parseQueryResponse(cache);
        }
    }

    function showError(response, className) {
        if (response && !response.error) {
            error.hide();

            return false;
        }

        error.text(response.error).show()[0].className = 'error-message' + (className || '');

        return true;
    }

    var captcha = $('#captcha'), captchaSubmit = captcha.find('button[type=submit]');

    function showCaptcha(response) {
        if (!response || !response.captcha) {
            return false;
        }

        captcha.find('input[type=text]').off('keydown').on('keydown', function (key) {
            if (key.keyCode === 13) {
                captchaSubmit.click();

                return false;
            }

            return true;
        });

        var submit = function () {
            $.post('/captcha', captcha.find('input').serialize(), function (response) {
                if (response.success) {
                    $('form button[type=submit]').not(captchaSubmit).prop('disabled', true);
                    captcha.hide().closest('form').submit();
                } else {
                    var error = captcha.find('.error-message');

                    captcha.find('input[type=text]').one('keydown', function () {
                        error.hide();
                    });
                    captchaSubmit.one('click', submit);
                    error.show();
                }
            });

            return false;
        };

        $('form button[type=submit]').not(captchaSubmit).prop('disabled', true);

        captchaSubmit.one('click', submit);
        captcha.show().find('input[type=text]').focus();

        return true;
    }

    // Note that we destroy resultset in this function!
    function prepareTable(target, resultset, response) {
        var grid, 
            columns = resultset.columns, 
            rows = resultset.rows,
            row, 
            options, 
            hasTags = false, 
            widths = [], 
            variables = [],
            sizerParent = document.createElement('div'),
            sizer = document.createElement('span'),
            maxWidth = 290;

        sizer.className = 'slick-cell';
        sizerParent.className = 'offscreen ui-widget';
        sizerParent.appendChild(sizer);
        document.body.appendChild(sizerParent);

        for (var i = 0; i < rows.length; ++i) {
            row = {};

            for (var c = 0; c < columns.length; ++c) {
                row["col" + c] = rows[i][c];

                // Skip dates because we always know what length they'll be,
                // ignoring the case of the completely blank column
                if (columns[c].type === 'Date') {
                    continue;
                }

                if (rows[i][c] != null && i < 500 && (!widths[c] || widths[c] < maxWidth)) {
                    if (rows[i][c].toString().length < 30) {
                        sizer[_textContent] = rows[i][c];

                        if (sizer.offsetWidth > (widths[c] || 0)) {
                            widths[c] = sizer.offsetWidth;
                        }
                    } else {
                        widths[c] = maxWidth;
                    }
                }
            }
            rows[i] = row;
        }

        sizer[_textContent] = '';
        sizer.className = 'slick-header-column slick-header-column-sorted ui-state-default';
        sizerParent.className += ' slick-header';
        sizerParent.appendChild(document.create('span', { classname: 'slick-sort-indicator' }));
        sizerParent.appendChild(document.create('div', { classname: 'slick-resizable-handle' }));

        var controlWidth = sizerParent.childNodes[1].offsetWidth + sizerParent.childNodes[2].offsetWidth;

        for (var i = 0; i < columns.length; ++i) {
            var name = columns[i].name.toLowerCase();

            if (columns[i].type === 'Date') {
                widths[i] = 160;
            }

            if (name === 'post link') {
                widths[i] = maxWidth;
            } else {
                sizer[_textContent] = columns[i].name;

                if (sizer.offsetWidth + controlWidth > widths[i]) {
                    widths[i] = sizer.offsetWidth + controlWidth;
                }
            }

            columns[i] = {
                'cssClass': columns[i].type === 'Number' ? 'number' : 'text',
                'id': "col" + i,
                'name': columns[i].name,
                'field': "col" + i,
                'type': columns[i].type.toLowerCase(),
                'width': Math.min(widths[i] || (50 + controlWidth), maxWidth),
                'sortable': rows.length <= 5000
            };

            if (name === 'tags' || name === 'tagname') {
                hasTags = true;
            }
        }

        document.body.removeChild(sizerParent);

        options = $.extend({}, gridOptions, {
            'formatterFactory': new ColumnFormatter(response),
            'rowHeight': hasTags ? 35 : 25, 
            'enableTextSelectionOnCells' : true
        });

        grid = new Slick.Grid(target, rows, columns, options);
        grid.onColumnsResized.subscribe(resizeResults);
        grid.onSort.subscribe(function (e, args) {
            var field = args.sortCol.field;

            args.grid.getData().sort(function (lhs, rhs) {
                return (args.sortAsc ? 1 : -1) * (lhs[field] == rhs[field] ? 0 : lhs[field] < rhs[field] ? -1 : 1);
            });

            args.grid.invalidate();
        });
    }

    function ColumnFormatter(response) {
        var base = response.url,
            autolinker = /^(https?|site):\/\/[-A-Z0-9+&@#\/%?=~_\[\]\(\)!:,\.;]*[-A-Z0-9+&@#\/%=~_\[\]](?:\|.+?)?$/i,
            dummy = document.createElement('a'),
            wrapper = dummy,
            _outerHTML = 'outerHTML';

        if (!dummy.outerHTML) {
            wrapper = document.createElement('span');
            _outerHTML = 'innerHTML';
            wrapper.appendChild(dummy);
        }

        var siteColumnName = null;
        if(response.resultSets && response.resultSets[0])
        {
            var cols = response.resultSets[0].columns; 
            for (var i = 0; i < cols.length; i++) {
                if (cols[i]["type"] == "site")
                {
                    siteColumnName = "col" + i;
                }
            }
        }

        this.getFormatter = function (column) {
            
            if (column.name.toLowerCase() === 'tags' || column.name.toLowerCase() === 'tagname') {
                return tagFormatter(siteColumnName);
            } else if (column.type) {
                switch (column.type) {
                    case 'user':
                        return linkFormatter('/users/', siteColumnName);
                    case 'post':
                        return linkFormatter('/questions/', siteColumnName);
                    case 'suggestededit':
                        return linkFormatter('/suggested-edits/', siteColumnName);
                    case 'comment':
                        return linkFormatter('/posts/comments/', siteColumnName);
                    case 'date':
                        return dateFormatter;
                    case 'site':
                        return siteFormatter;
                }
            }

            return defaultFormatter;
        };

        function defaultFormatter(row, cell, value, column, context) {
            if (value == null) {
                value = "";
            }

            var matches;
            
            if (typeof value === 'string' && (matches = autolinker.exec(value))) {
                var url = value,
                    description = value,
                    split = value.split("|");

                if (split.length == 2) {
                    url = split[0];
                    description = split[1];
                }

                if (matches[1] === 'site') {
                    url = url.substring('site:/'.length);

                    if (siteColumnName) {
                        url = context[siteColumnName].url + url;
                    } else {
                        url = base + url;
                    }
                }

                dummy.setAttribute('href', url);
                // If we want literal entities to be rendered, this won't work
                // But I'm not sure why we would, so this seems reasonable.
                dummy[_textContent] = description;

                // Firefox doesn't have outerHTML, so we have some hackery...
                value = wrapper[_outerHTML];
            } else {
                value = encodeColumn(value);
            }

            return value;
        }
        
        function dateFormatter(row, cell, value, column, context) {
            if (!value) {
                return defaultFormatter(row, cell, value, column, context);
            }
            
            return (new Date(value)).toUTC();
        }

        function tagFormatter(siteColumnName) { 
            var siteColumnName = siteColumnName;

            return function (row, cell, value, column, context) {
                var isMultiTags;

                if (!value || !(value.match(/^[a-z0-9#.+-]+$/) || (isMultiTags = (value.search(/^(?:<[a-z0-9#.+-]+>)+$/) > -1)))) {
                    return defaultFormatter(row, cell, value, column, context);
                }

                var tags = isMultiTags ? value.substring(1, value.length - 1).split('><') : [value],
                    template = '<a class="post-tag :class" href=":base/tags/:url">:tag</a>',
                    value = '', tag;

                var url = base;
                if (siteColumnName != null)
                {
                    url = context[siteColumnName].url;
                }

                for (var i = 0; i < tags.length; ++i) {
                    tag = tags[i];

                    value = value + template.format({
                        'base': url,
                        'class': '',
                        'tag': tag,
                        'url': encodeURIComponent(tag)
                    });
                }

                return value;
            }
        }

        function siteFormatter(row, cell, value, column, context) {
            var template = '<a href=":url">:text</a>';

            if (!value || typeof value !== 'object') {
                return defaultFormatter(row, cell, value, column, context);
            }

            return template.format({
                'url': value.url,
                'text': encodeColumn(value.name)
            });
        }


        function linkFormatter(path, siteColumnName) {
            var url = base + path, 
                template = '<a href=":url">:text</a>',
                siteColumnName = siteColumnName,
                path = path;

            return function (row, cell, value, column, context) {
                if (!value || typeof value !== 'object') {
                    return defaultFormatter(row, cell, value, column, context);
                }

                var currentUrl = url;

                if (siteColumnName != null)
                {
                    currentUrl = context[siteColumnName].url + path;
                }

                return template.format({
                    'url': currentUrl + value.id,
                    'text': encodeColumn(value.title)
                });
            };
        }
    }
});

function encodeColumn(s) {
    if (s != null && s.replace != null) {
        s = s.replace(/[\n\r]/g, " ")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .substring(0, 400);
        return s;
    } else {
        return s;
    }
}

// this is from SO 901115
function getParameterByName(name) {
    name = name.replace(/[\[]/, "\\\[").replace(/[\]]/, "\\\]");
    var regexS = "[\\?&]" + name + "=([^&#]*)";
    var regex = new RegExp(regexS);
    var results = regex.exec(window.location.href);
    if (results == null)
        return "";
    else
        return decodeURIComponent(results[1].replace(/\+/g, " "));
}

function populateParamsFromUrl() {
    $('#query-params input').each(function () {
        var value = getParameterByName(this.name);

        if (value != null && value.length > 0) {
            this.value = value;
        }
    });
}