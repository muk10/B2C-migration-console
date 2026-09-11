'use strict';

var runtimeAttrMap = require('*/cartridge/scripts/migration/core/runtimeAttrMap');

function escapeXml(val) {
    if (!val) return '';
    return String(val)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

function buildLocalizedElement(tagName, localizedObj) {
    if (!localizedObj || Object.keys(localizedObj).length === 0) return '';
    var xml = '';
    // x-default must come first
    var keys = Object.keys(localizedObj).sort(function (a, b) {
        if (a === 'x-default') return -1;
        if (b === 'x-default') return 1;
        return a.localeCompare(b);
    });
    keys.forEach(function (lang) {
        var val = escapeXml(localizedObj[lang]);
        if (val) {
            xml += '        <' + tagName + ' xml:lang="' + lang + '">' + val + '</' + tagName + '>\n';
        }
    });
    return xml;
}

// function buildCategoryXml(sfccCategory) {
//     var xml = '    <category category-id="' + escapeXml(sfccCategory.id) + '">\n';

//     /*
//      * SFCC catalog.xsd STRICT element order:
//      * 1.  display-name      (0..unbounded, localized)
//      * 2.  description       (0..unbounded, localized)
//      * 3.  parent            (0..1)
//      * 4.  position          (0..1)
//      * 5.  thumbnail         (0..1)
//      * 6.  image             (0..1)
//      * 7.  template          (0..1)
//      * 8.  search-placement  (0..1)
//      * 9.  search-rank       (0..1)
//      * 10. sitemap-*         (0..1 each)
//      * 11. page-attributes   (0..1) → contains page-title, page-description, page-keywords, page-url
//      * 12. custom-attributes (0..1)
//      * 13. category-links    (0..1)
//      * 14. attribute-groups  (0..1)
//      * 15. refinement-definitions
//      * 16. online-flag       ← THIS IS LAST, not early — that's the bug
//      */

//     // 1. display-name
//     xml += buildLocalizedElement('display-name', sfccCategory.name);

//     // 2. description
//     xml += buildLocalizedElement('description', sfccCategory.description);

//     // 3. parent
//     if (sfccCategory.parentId && sfccCategory.parentId !== 'root') {
//         xml += '        <parent>' + escapeXml(sfccCategory.parentId) + '</parent>\n';
//     }

//     // 4. position
//     if (sfccCategory.position !== undefined && sfccCategory.position !== null) {
//         xml += '        <position>' + sfccCategory.position + '</position>\n';
//     }

//     // 11. page-attributes block (contains page-title, page-description)
//     var hasPageTitle = sfccCategory.pageTitle && Object.keys(sfccCategory.pageTitle).length > 0;
//     var hasPageDesc  = sfccCategory.pageDescription && Object.keys(sfccCategory.pageDescription).length > 0;

//     if (hasPageTitle || hasPageDesc) {
//         xml += '        <page-attributes>\n';
//         if (hasPageTitle) {
//             var pageTitleKeys = Object.keys(sfccCategory.pageTitle).sort(function (a, b) {
//                 if (a === 'x-default') return -1;
//                 if (b === 'x-default') return 1;
//                 return a.localeCompare(b);
//             });
//             pageTitleKeys.forEach(function (lang) {
//                 var val = escapeXml(sfccCategory.pageTitle[lang]);
//                 if (val) {
//                     xml += '            <page-title xml:lang="' + lang + '">' + val + '</page-title>\n';
//                 }
//             });
//         }
//         if (hasPageDesc) {
//             var pageDescKeys = Object.keys(sfccCategory.pageDescription).sort(function (a, b) {
//                 if (a === 'x-default') return -1;
//                 if (b === 'x-default') return 1;
//                 return a.localeCompare(b);
//             });
//             pageDescKeys.forEach(function (lang) {
//                 var val = escapeXml(sfccCategory.pageDescription[lang]);
//                 if (val) {
//                     xml += '            <page-description xml:lang="' + lang + '">' + val + '</page-description>\n';
//                 }
//             });
//         }
//         xml += '        </page-attributes>\n';
//     }

//     // 12. custom-attributes
//     var ctSlug = sfccCategory.customAttributes && sfccCategory.customAttributes.ctSlug;
//     var ctId   = sfccCategory.customAttributes && sfccCategory.customAttributes.ctId;
//     if (ctSlug || ctId) {
//         xml += '        <custom-attributes>\n';
//         if (ctSlug) {
//             xml += '            <custom-attribute attribute-id="ctSlug">' + escapeXml(ctSlug) + '</custom-attribute>\n';
//         }
//         if (ctId) {
//             xml += '            <custom-attribute attribute-id="ctId">' + escapeXml(ctId) + '</custom-attribute>\n';
//         }
//         xml += '        </custom-attributes>\n';
//     }

//     xml += '    </category>\n';
//     return xml;
// }
function buildCategoryXml(sfccCategory) {
    var mapped = runtimeAttrMap.apply(sfccCategory.customAttributes || {}, 'category');
    if ((!sfccCategory.template) && mapped.system.template) {
        sfccCategory.template = mapped.system.template;
    }

    var xml = '    <category category-id="' + escapeXml(sfccCategory.id) + '">\n';

    // catalog.xsd Category: display-name → description → online-flag… → parent → position → … → page-attributes
    xml += buildLocalizedElement('display-name', sfccCategory.name);
    xml += buildLocalizedElement('description', sfccCategory.description);

    // parent — skip unused online-flag/from/to; always write, including 'root'
    if (sfccCategory.parentId) {
        xml += '        <parent>' + escapeXml(sfccCategory.parentId) + '</parent>\n';
    }

    // 4. position — uses the raw CT orderHint string when available, since
    // parseFloat (sfccCategory.position) truncates precision beyond a JS double;
    // orderHint is a string by design to support arbitrary-precision ordering.
    if (sfccCategory.positionRaw) {
        xml += '        <position>' + escapeXml(sfccCategory.positionRaw) + '</position>\n';
    } else if (sfccCategory.position !== undefined && sfccCategory.position !== null) {
        xml += '        <position>' + sfccCategory.position + '</position>\n';
    }

    if (sfccCategory.template) {
        xml += '        <template>' + escapeXml(sfccCategory.template) + '</template>\n';
    }

    // 5. page-attributes
    var hasPageTitle = sfccCategory.pageTitle
        && Object.keys(sfccCategory.pageTitle).length > 0;
    var hasPageDesc  = sfccCategory.pageDescription
        && Object.keys(sfccCategory.pageDescription).length > 0;
    var hasPageKeywords = sfccCategory.pageKeywords
        && Object.keys(sfccCategory.pageKeywords).length > 0;
    var hasPageURL = sfccCategory.pageURL
        && Object.keys(sfccCategory.pageURL).length > 0;

    if (hasPageTitle || hasPageDesc || hasPageKeywords || hasPageURL) {
        xml += '        <page-attributes>\n';
        if (hasPageTitle) {
            Object.keys(sfccCategory.pageTitle)
                .sort(function (a, b) {
                    if (a === 'x-default') return -1;
                    if (b === 'x-default') return 1;
                    return a.localeCompare(b);
                })
                .forEach(function (lang) {
                    var val = escapeXml(sfccCategory.pageTitle[lang]);
                    if (val) {
                        xml += '            <page-title xml:lang="' + lang + '">'
                            + val + '</page-title>\n';
                    }
                });
        }
        if (hasPageDesc) {
            Object.keys(sfccCategory.pageDescription)
                .sort(function (a, b) {
                    if (a === 'x-default') return -1;
                    if (b === 'x-default') return 1;
                    return a.localeCompare(b);
                })
                .forEach(function (lang) {
                    var val = escapeXml(sfccCategory.pageDescription[lang]);
                    if (val) {
                        xml += '            <page-description xml:lang="' + lang + '">'
                            + val + '</page-description>\n';
                    }
                });
        }
        if (hasPageKeywords) {
            Object.keys(sfccCategory.pageKeywords)
                .sort(function (a, b) {
                    if (a === 'x-default') return -1;
                    if (b === 'x-default') return 1;
                    return a.localeCompare(b);
                })
                .forEach(function (lang) {
                    var val = escapeXml(sfccCategory.pageKeywords[lang]);
                    if (val) {
                        xml += '            <page-keywords xml:lang="' + lang + '">'
                            + val + '</page-keywords>\n';
                    }
                });
        }
        if (hasPageURL) {
            Object.keys(sfccCategory.pageURL)
                .sort(function (a, b) {
                    if (a === 'x-default') return -1;
                    if (b === 'x-default') return 1;
                    return a.localeCompare(b);
                })
                .forEach(function (lang) {
                    var val = escapeXml(sfccCategory.pageURL[lang]);
                    if (val) {
                        xml += '            <page-url xml:lang="' + lang + '">'
                            + val + '</page-url>\n';
                    }
                });
        }
        xml += '        </page-attributes>\n';
    }

    if (mapped.custom && mapped.custom.length) {
        xml += '        <custom-attributes>\n';
        mapped.custom.forEach(function (ca) {
            if (!ca || !ca.id || ca.value === '' || ca.value == null) return;
            xml += '            <custom-attribute attribute-id="' + escapeXml(ca.id) + '">'
                + escapeXml(runtimeAttrMap.formatCustomAttrValue(ca.value)) + '</custom-attribute>\n';
        });
        xml += '        </custom-attributes>\n';
    }

    xml += '    </category>\n';
    return xml;
}

function buildCatalogXml(catalogId, sfccCategories) {
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31"\n';
    xml += '         catalog-id="' + escapeXml(catalogId) + '">\n\n';

    sfccCategories.forEach(function (cat) {
        xml += buildCategoryXml(cat);
        xml += '\n';
    });

    xml += '</catalog>';
    return xml;
}

module.exports = {
    buildCatalogXml: buildCatalogXml
};