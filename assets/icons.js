/* assets/icons.js — Bibliothèque d'icônes SVG unique de l'application ASUFOR.
 *
 * Objectif (refonte "système visuel") : une SEULE source d'icônes, en SVG
 * inline, pour remplacer à la fois les emojis (📟, ✓, ⚠, 🔍…) et la
 * dépendance externe Font Awesome. Avantages : rendu identique sur tous les
 * appareils (Android/iPhone/PC), aucune requête réseau (donc fonctionne
 * hors-ligne), couleur pilotée par `currentColor` (donc s'aligne sur la
 * couleur du texte / des jetons de thème).
 *
 * Deux usages :
 *   1. Statique — placer `<span class="ic" data-ic="edit"></span>` dans le
 *      HTML ; `AsuforIcons.hydrate()` (appelé automatiquement au chargement)
 *      injecte le SVG. Les anciennes balises `<i class="fa-solid fa-...">`
 *      sont AUSSI converties automatiquement (compatibilité ascendante).
 *   2. Dynamique — dans du JS qui construit du HTML (ex. la liste des
 *      relevés), utiliser `AsuforIcons.svg('edit')` qui retourne la chaîne
 *      SVG à insérer dans un template littéral.
 *
 * Toutes les icônes partagent un viewBox 0 0 24 24 et utilisent
 * `fill="currentColor"` (ou `stroke`) pour hériter de la couleur ambiante.
 */
(function (global) {
    'use strict';

    // Chemins SVG (viewBox 24×24). Style "plein" cohérent (Material-like).
    var PATHS = {
        // Navigation
        'arrow-left':  '<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/>',
        'arrow-right': '<path d="M4 13h12.17l-5.59 5.59L12 20l8-8-8-8-1.41 1.41L16.17 11H4z"/>',
        'arrow-up':    '<path d="M13 20V7.83l5.59 5.59L20 12l-8-8-8 8 1.41 1.41L11 7.83V20z"/>',
        'arrow-down':  '<path d="M11 4v12.17l-5.59-5.59L4 12l8 8 8-8-1.41-1.41L13 16.17V4z"/>',
        'chevron-right':'<path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/>',
        'close':       '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',

        // Thème
        'theme':       '<path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-5.4-5.4c0-1.81.89-3.42 2.26-4.4C12.92 3.04 12.46 3 12 3z"/>',
        'sun':         '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2zm18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2zM11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0zm0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0zM5.99 4.58 4.58 5.99a1 1 0 0 0 1.41 1.41l1.41-1.41A1 1 0 0 0 5.99 4.58zm12.02 12.02-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41a1 1 0 0 0-1.41-1.41zM18.01 4.58a1 1 0 0 0-1.41 0l-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41a1 1 0 0 0 0-1.41zM5.99 16.6l-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41a1 1 0 0 0-1.41-1.41z"/>',

        // Métier / données
        'gauge':       '<path d="M12 4a8 8 0 0 0-6.34 12.88h12.68A8 8 0 0 0 12 4zm0 3a1 1 0 0 1 1 1v.5a1 1 0 0 1-2 0V8a1 1 0 0 1 1-1zM6.5 12a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm11 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-3.09-3.09-1.8 1.8a1.5 1.5 0 1 0 1.06 1.06l1.8-1.8a.5.5 0 0 0-.7-.7z"/>',
        'droplet':     '<path d="M12 2.5S5.5 9.5 5.5 14a6.5 6.5 0 0 0 13 0C18.5 9.5 12 2.5 12 2.5zm0 15a3.5 3.5 0 0 1-3.5-3.5 1 1 0 0 1 2 0A1.5 1.5 0 0 0 12 15.5a1 1 0 0 1 0 2z"/>',
        'location':    '<path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>',
        'house':       '<path d="M12 3 3 10.5V21h6v-6h6v6h6V10.5z"/>',
        'user':        '<path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z"/>',
        'users':       '<path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.67 0-8 1.34-8 4v2h9v-2c0-1.4.62-2.55 1.6-3.4A11 11 0 0 0 8 13zm8 0c-.35 0-.74.02-1.15.06C15.7 13.9 16 15 16 16v2h8v-2c0-2.66-5.33-4-8-4z"/>',
        'phone':       '<path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.57 3.6a1 1 0 0 1-.25 1z"/>',
        'lock':        '<path d="M17 9V7a5 5 0 0 0-10 0v2H5v12h14V9zm-8-2a3 3 0 0 1 6 0v2H9zm3 6a1.5 1.5 0 0 1 1 2.6V18a1 1 0 0 1-2 0v-2.4A1.5 1.5 0 0 1 12 13z"/>',
        'edit':        '<path d="M3 17.25V21h3.75l11.06-11.06-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/>',
        'collect':     '<path d="M21 7h-3V5.5A2.5 2.5 0 0 0 15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zm-4 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM5 7a1 1 0 0 1 0-2h10.5a.5.5 0 0 1 .5.5V7z"/>',
        'undo':        '<path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>',
        'search':      '<path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 5L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>',
        'microphone':  '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/>',
        'plus':        '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/>',
        'trash':       '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/>',
        'key':         '<path d="M12.65 10A5.99 5.99 0 0 0 7 6a6 6 0 0 0 0 12 5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>',
        'camera':      '<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>',
        'calendar':    '<path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14zM5 8V6h14v2z"/>',
        'eye':         '<path d="M12 5C6.5 5 2.7 8.6 1 12c1.7 3.4 5.5 7 11 7s9.3-3.6 11-7c-1.7-3.4-5.5-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
        'eye-off':     '<path d="M12 7a4 4 0 0 1 4 4c0 .5-.1 1-.3 1.4l2.3 2.3A11.4 11.4 0 0 0 23 11c-1.7-3.4-5.5-7-11-7-1.4 0-2.7.25-3.9.68l1.7 1.7C11.2 7.1 11.6 7 12 7zM2.4 3.1 1 4.5l3.1 3.1A11.6 11.6 0 0 0 1 11c1.7 3.4 5.5 7 11 7 1.5 0 3-.3 4.3-.8l3.2 3.2 1.4-1.4zM12 15a4 4 0 0 1-4-4c0-.3 0-.6.1-.9l5.8 5.8c-.3.1-.6.1-.9.1z"/>',
        'printer':     '<path d="M19 8H5a3 3 0 0 0-3 3v6h4v4h12v-4h4v-6a3 3 0 0 0-3-3zm-3 11H8v-5h8zm3-7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-1-9H6v4h12z"/>',
        'water-tap':   '<path d="M11 3v3H4v2h7v2H6a2 2 0 0 0-2 2v2h2v-2h5v2.05A4 4 0 0 0 9 20a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1 4 4 0 0 0-2-3.95V8h6a2 2 0 0 0-2-5z"/>',
        'folder':      '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"/>',
        'save':        '<path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zM12 19a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10z"/>',
        'star':        '<path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>',
        'scissors':    '<path d="M9.64 7.64A3 3 0 1 0 6 9.83l2.5 2.17L6 14.17a3 3 0 1 0 1.32 1.5L12 12l6.5 5.5H21v-1l-8.86-7.5.5-.44zM5 8a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm0 9a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm7-4.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1zM18.5 6 12 11.5l-1.32-1.12L18.5 5H21v1z"/>',
        'list':        '<path d="M4 6h2v2H4zm0 5h2v2H4zm0 5h2v2H4zM8 6h12v2H8zm0 5h12v2H8zm0 5h12v2H8z"/>',
        'signal-off':  '<path d="M2.28 3 1 4.27 6 9.27V17a2 2 0 0 0 2 2h7.73l3 3L21 20.72zM12 4a8 8 0 0 1 8 8 8 8 0 0 1-1.06 3.98l-1.47-1.47A6 6 0 0 0 12 6c-.6 0-1.18.09-1.73.25L8.8 4.78A8 8 0 0 1 12 4z"/>',
        'clock':       '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.41 3.29 3.3-1.42 1.41L11 13.24V7h2z"/>',
        'refresh':     '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10H17.6A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/>',

        // États (statuts)
        'check':          '<path d="M9 16.17 4.83 12 3.41 13.41 9 19 21 7l-1.41-1.42z"/>',
        'check-circle':   '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z"/>',
        'alert-circle':   '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z"/>',
        'alert-triangle': '<path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/>',
        'dot':            '<circle cx="12" cy="12" r="6"/>'
    };

    // Alias pour couvrir les anciens noms Font Awesome sans dupliquer les chemins.
    var ALIAS = {
        'pen-to-square': 'edit',
        'pencil-alt': 'edit',
        'pencil': 'edit',
        'moon': 'theme',
        'location-dot': 'location',
        'gauge-high': 'gauge',
        'rotate-left': 'undo',
        'circle-check': 'check-circle',
        'circle-exclamation': 'alert-circle',
        'triangle-exclamation': 'alert-triangle',
        'exclamation-triangle': 'alert-triangle',
        'times': 'close',
        'xmark': 'close',
        'print': 'printer',
        'file-pdf': 'printer',
        'file-excel': 'folder',
        'hand-holding-dollar': 'collect',
        'magnifying-glass': 'search'
    };

    function resolve(name) {
        if (!name) return null;
        name = String(name).replace(/^fa-/, '');
        if (PATHS[name]) return name;
        if (ALIAS[name]) return ALIAS[name];
        return null;
    }

    function svg(name, opts) {
        opts = opts || {};
        var key = resolve(name);
        if (!key) return '';
        var size = opts.size || '1em';
        var cls = opts.cls ? ' ' + opts.cls : '';
        var extra = opts.stroke ? ' stroke="currentColor"' : '';
        return '<svg class="ic-svg' + cls + '" viewBox="0 0 24 24" width="' + size +
            '" height="' + size + '" fill="currentColor"' + extra +
            ' aria-hidden="true" focusable="false">' + PATHS[key] + '</svg>';
    }

    function hydrate(root) {
        root = root || document;

        // 1. Balises data-ic (nouveau système)
        root.querySelectorAll('[data-ic]').forEach(function (el) {
            if (el.getAttribute('data-ic-done') === '1') return;
            var name = el.getAttribute('data-ic');
            if (resolve(name)) {
                el.innerHTML = svg(name);
                el.classList.add('ic');
                el.setAttribute('data-ic-done', '1');
            }
        });

        // 2. Anciennes icônes Font Awesome — converties automatiquement en SVG.
        //    On conserve la balise <i> (pour ne pas casser les sélecteurs CSS du
        //    type `.citem-sub i`) : on y injecte le SVG et on retire les classes
        //    `fa-*` pour éviter tout double rendu si Font Awesome venait à charger.
        root.querySelectorAll('i[class*="fa-"]').forEach(function (el) {
            if (el.getAttribute('data-ic-done') === '1') return;
            var match = (el.className || '').match(/fa-([a-z0-9-]+)/g) || [];
            var name = null;
            for (var i = 0; i < match.length; i++) {
                var n = match[i].replace('fa-', '');
                if (n === 'solid' || n === 'regular' || n === 'brands' || n === 'fw' ||
                    n === 'lg' || n === 'spin' || /^\dx$/.test(n) || n === 'xs' || n === 'sm') continue;
                if (resolve(n)) { name = n; break; }
                if (!name) name = n; // garde le premier "vrai" nom même sans correspondance
            }
            if (resolve(name)) {
                el.innerHTML = svg(name);
                el.className = el.className.replace(/\bfa-[a-z0-9-]+/g, '').trim();
                el.classList.add('ic');
                el.setAttribute('data-ic-done', '1');
            }
        });
    }

    global.AsuforIcons = { svg: svg, hydrate: hydrate, has: function (n) { return !!resolve(n); } };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { hydrate(); });
    } else {
        hydrate();
    }
})(window);
