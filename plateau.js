/* =========================================================================
   REBONDIS BULLES — RENDU PIXEL ART
   Dessine le plateau sur un canvas basse résolution (16 × 12 = 192 px de
   côté) agrandi en pixels nets. Le mouvement est purement visuel : l'état
   du jeu est déjà à jour dans le moteur quand l'animation démarre.
   ========================================================================= */

(function (M, global) {
  'use strict';

  var CASE = 12;                       // pixels internes par case
  var COTE = CASE * M.TAILLE;          // 192
  var MARGE = 2;                       // bord de la case autour d'une bulle
  var REBOND = 2;                      // profondeur du rebond, en pixels
  var MS_COURSE = 55;                  // durée fixe, quelle que soit la distance
  var MS_IMPACT = 70;                  // durée de l'écrasement contre l'obstacle
  var PLAQUAGE = 2;                    // de combien le corps se plaque au mur
  var TRAINEE = 0.55;                  // intensité de la traînée (0 = invisible)

  /* Sprites 8 × 8. '#' = pixel plein. */
  var SPRITES = {
    cercle: [
      '..####..',
      '.######.',
      '########',
      '########',
      '########',
      '########',
      '.######.',
      '..####..'
    ],
    carre: [
      '########',
      '########',
      '########',
      '########',
      '########',
      '########',
      '########',
      '########'
    ],
    triangle: [
      '...##...',
      '...##...',
      '..####..',
      '..####..',
      '.######.',
      '.######.',
      '########',
      '########'
    ],
    etoile: [
      '...##...',
      '...##...',
      '..####..',
      '########',
      '########',
      '..####..',
      '...##...',
      '...##...'
    ]
  };
  SPRITES.vortex = SPRITES.cercle;

  /* Le corps se déforme au lieu de se déplacer : allongé dans l'axe de la
     course, comprimé dans cet axe au moment du choc. Deux masques suffisent,
     l'un étant la transposée de l'autre. */
  var LARGE = [                        // 10 × 6, course horizontale
    '..######..',
    '.########.',
    '##########',
    '##########',
    '.########.',
    '..######..'
  ];
  var HAUT = [                         // 6 × 10, course verticale
    '..##..',
    '.####.',
    '######',
    '######',
    '######',
    '######',
    '######',
    '######',
    '.####.',
    '..##..'
  ];

  var DECALAGES = {
    haut:   { dx: 0,  dy: -1 },
    droite: { dx: 1,  dy: 0  },
    bas:    { dx: 0,  dy: 1  },
    gauche: { dx: -1, dy: 0  }
  };

  var canvas = null, ctx = null, plateau = null;
  var etat = { positions: [0, 0, 0, 0], jetonIndex: 0, selection: 0, resolu: false };
  var anim = null;                     // { bulle, depuis, vers, dx, dy, debut, glisse, total }
  var boucle = null;
  var couleurs = {};
  var surFin = null, surImpact = null;

  /* ------------------------------------------------------------ THÈME --- */

  var REPLI = {
    '--fond': '#000000', '--carte': '#16161C', '--brume': '#8D8D93', '--texte': '#F1F0EC',
    '--jeu-rouge': '#DA9781', '--jeu-vert': '#7EC8A3', '--jeu-bleu': '#8CACD9', '--jeu-jaune': '#DAC581'
  };

  /* Accepte #rgb, #rrggbb et rgb(...). */
  function versRvb(c) {
    if (!c) return [0, 0, 0];
    if (c.charAt(0) === '#') {
      var h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var m = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  }

  /* Rapproche une couleur du fond : sert à éteindre les jetons non tirés
     sans recourir à la transparence, qui brouillerait les pixels. */
  function estomper(couleur, fond, part) {
    var a = versRvb(couleur), b = versRvb(fond);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * part) + ',' +
                    Math.round(a[1] + (b[1] - a[1]) * part) + ',' +
                    Math.round(a[2] + (b[2] - a[2]) * part) + ')';
  }

  function lireCouleurs() {
    var style = getComputedStyle(document.documentElement);
    function v(nom) { return (style.getPropertyValue(nom) || '').trim() || REPLI[nom]; }
    couleurs = {
      fond: v('--fond'),
      carte: v('--carte'),
      brume: v('--brume'),
      texte: v('--texte'),
      rouge: v('--jeu-rouge'),
      vert: v('--jeu-vert'),
      bleu: v('--jeu-bleu'),
      jaune: v('--jeu-jaune')
    };
  }

  function mouvementReduit() {
    return global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ----------------------------------------------------------- DESSIN --- */

  function pixel(x, y, w, h, couleur) {
    ctx.fillStyle = couleur;
    ctx.fillRect(x, y, w, h);
  }

  function plein(motif, x, y) {
    return x >= 0 && y >= 0 && x < 8 && y < 8 && motif[y][x] === '#';
  }

  /* Un pixel de contour : plein, mais bordant le vide. Les jetons sont
     dessinés en contour et les bulles en disque plein, pour qu'un jeton
     rond ne puisse jamais être confondu avec une bulle de même couleur. */
  function contour(motif, x, y) {
    if (!plein(motif, x, y)) return false;
    return !plein(motif, x - 1, y) || !plein(motif, x + 1, y) ||
           !plein(motif, x, y - 1) || !plein(motif, x, y + 1);
  }

  function sprite(motif, px, py, couleur, creux) {
    ctx.fillStyle = couleur;
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        if (creux ? !contour(motif, x, y) : motif[y][x] !== '#') continue;
        ctx.fillRect(px + x, py + y, 1, 1);
      }
    }
  }

  /* Dessine un masque quelconque centré sur un point. */
  function corps(motif, cx, cy, couleur) {
    var h = motif.length, l = motif[0].length;
    var px = Math.round(cx - l / 2), py = Math.round(cy - h / 2);
    ctx.fillStyle = couleur;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < l; x++) {
        if (motif[y][x] === '#') ctx.fillRect(px + x, py + y, 1, 1);
      }
    }
  }

  function spriteVortex(px, py, part) {
    var motif = SPRITES.cercle;
    var quart = [couleurs.rouge, couleurs.vert, couleurs.bleu, couleurs.jaune];
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        if (!contour(motif, x, y)) continue;
        var c = quart[(y < 4 ? 0 : 2) + (x < 4 ? 0 : 1)];
        ctx.fillStyle = part ? estomper(c, couleurs.fond, part) : c;
        ctx.fillRect(px + x, py + y, 1, 1);
      }
    }
  }

  function dessinerMurs() {
    for (var y = 0; y < M.TAILLE; y++) {
      for (var x = 0; x < M.TAILLE; x++) {
        var c = plateau.cellules[M.index(x, y)];
        /* Un mur est partagé par deux cases : on ne trace que le haut et la
           gauche, plus les deux bords extrêmes. Sinon chaque cloison
           apparaîtrait en double. */
        if (c.top)  pixel(x * CASE, y * CASE, CASE, 1, couleurs.brume);
        if (c.left) pixel(x * CASE, y * CASE, 1, CASE, couleurs.brume);
        if (y === M.TAILLE - 1 && c.bottom) pixel(x * CASE, COTE - 1, CASE, 1, couleurs.brume);
        if (x === M.TAILLE - 1 && c.right)  pixel(COTE - 1, y * CASE, 1, CASE, couleurs.brume);
      }
    }
  }

  function centreCase(p) {
    return { x: M.colonne(p) * CASE + CASE / 2, y: M.ligne(p) * CASE + CASE / 2 };
  }

  /* Renvoie le corps à dessiner pour une bulle : sa forme et son centre.
     Toute l'énergie du mouvement passe par la déformation — la position, elle,
     reste rigoureusement sur la grille. */
  function corpsBulle(i) {
    var centre = centreCase(etat.positions[i]);
    var forme = SPRITES.cercle;

    if (!anim || anim.bulle !== i) return { forme: forme, x: centre.x, y: centre.y };

    var t = Date.now() - anim.debut;
    var depart = centreCase(anim.depuis);
    var horizontal = anim.dx !== 0;

    if (t < anim.glisse) {
      /* Course : vitesse constante, corps étiré dans l'axe. */
      var k = t / anim.glisse;
      return {
        forme: horizontal ? LARGE : HAUT,
        x: depart.x + (centre.x - depart.x) * k,
        y: depart.y + (centre.y - depart.y) * k
      };
    }

    if (!anim.choque) {
      anim.choque = true;
      if (surImpact) surImpact(anim.cases);      // c'est ici que le son tombe
    }

    /* Choc : le corps s'aplatit contre l'obstacle, comprimé dans l'axe de sa
       course, et se plaque contre lui. Il ne recule pas — l'énergie part dans
       la forme, jamais dans un rebond. */
    var r = Math.min(1, (t - anim.glisse) / MS_IMPACT);
    var reste = 1 - r;
    return {
      forme: reste > 0.45 ? (horizontal ? HAUT : LARGE) : SPRITES.cercle,
      x: centre.x + anim.dx * PLAQUAGE * reste,
      y: centre.y + anim.dy * PLAQUAGE * reste
    };
  }

  /* Traînée : une bande derrière la bulle, qui s'efface avec le choc. */
  function dessinerTrainee() {
    if (!anim || TRAINEE <= 0) return;
    var t = Date.now() - anim.debut;
    var depart = centreCase(anim.depuis);
    var corps0 = corpsBulle(anim.bulle);
    var part = t < anim.glisse
      ? TRAINEE
      : TRAINEE + (1 - TRAINEE) * Math.min(1, (t - anim.glisse) / MS_IMPACT);
    if (part >= 1) return;

    var teinte = estomper(couleurs[M.COULEURS[anim.bulle]], couleurs.fond, part);
    var x1 = Math.min(depart.x, corps0.x), x2 = Math.max(depart.x, corps0.x);
    var y1 = Math.min(depart.y, corps0.y), y2 = Math.max(depart.y, corps0.y);
    if (anim.dx !== 0) pixel(Math.round(x1), Math.round(y1 - 1), Math.round(x2 - x1), 2, teinte);
    else pixel(Math.round(x1 - 1), Math.round(y1), 2, Math.round(y2 - y1), teinte);
  }

  function dessiner() {
    if (!ctx) return;
    var jeton = plateau.jetons[etat.jetonIndex];
    var but = M.index(jeton.x, jeton.y);

    pixel(0, 0, COTE, COTE, couleurs.fond);

    /* Trame de fond. */
    for (var i = 1; i < M.TAILLE; i++) {
      pixel(i * CASE, 0, 1, COTE, couleurs.carte);
      pixel(0, i * CASE, COTE, 1, couleurs.carte);
    }

    /* Case visée : teintée de la couleur du jeton en jeu, pour qu'on la
       repère d'un coup d'œil sans avoir à lire la forme. */
    var teinte = jeton.couleur === 'vortex'
      ? couleurs.carte
      : estomper(couleurs[jeton.couleur], couleurs.fond, 0.8);
    pixel(M.colonne(but) * CASE, M.ligne(but) * CASE, CASE, CASE, teinte);
    pixel(7 * CASE, 7 * CASE, CASE * 2, CASE * 2, couleurs.carte);

    /* Jetons en contour : pleine couleur pour celui qui est en jeu,
       estompé vers le fond pour les autres. */
    plateau.jetons.forEach(function (j) {
      var px = j.x * CASE + MARGE, py = j.y * CASE + MARGE;
      var actif = M.index(j.x, j.y) === but;
      if (j.couleur === 'vortex') { spriteVortex(px, py, actif ? 0 : 0.5); return; }
      var c = actif ? couleurs[j.couleur] : estomper(couleurs[j.couleur], couleurs.fond, 0.5);
      sprite(SPRITES[j.forme], px, py, c, true);
    });

    dessinerMurs();

    /* Repère de sélection, sous les bulles : le corps étiré déborde jusqu'aux
       bords de la case, un cadre dessiné par-dessus lui mangerait ses
       extrémités. */
    /* Pendant la course, le cadre est masqué : sinon il apparaîtrait sur la
       case d'arrivée avant que le corps n'y soit, et annoncerait le résultat. */
    if (!etat.resolu && !(anim && anim.bulle === etat.selection)) {
      var sel = etat.positions[etat.selection];
      var sx = M.colonne(sel) * CASE, sy = M.ligne(sel) * CASE;
      ctx.fillStyle = couleurs.texte;
      ctx.fillRect(sx + 1, sy + 1, CASE - 2, 1);
      ctx.fillRect(sx + 1, sy + CASE - 2, CASE - 2, 1);
      ctx.fillRect(sx + 1, sy + 1, 1, CASE - 2);
      ctx.fillRect(sx + CASE - 2, sy + 1, 1, CASE - 2);
    }

    dessinerTrainee();

    /* Bulles. */
    for (var b = 0; b < 4; b++) {
      var c = corpsBulle(b);
      corps(c.forme, c.x, c.y, couleurs[M.COULEURS[b]]);
    }

  }

  /* --------------------------------------------------------- BOUCLE --- */

  function tourner() {
    dessiner();
    if (!anim) { boucle = null; return; }
    if (Date.now() - anim.debut >= anim.total) {
      anim = null;
      dessiner();
      boucle = null;
      if (surFin) surFin();          // le coup mis en file peut partir
      return;
    }
    boucle = global.requestAnimationFrame(tourner);
  }

  function lancer() {
    if (boucle === null) boucle = global.requestAnimationFrame(tourner);
  }

  /* ------------------------------------------------------- API --- */

  var API = {
    init: function (element, plateauJeu) {
      plateau = plateauJeu;
      canvas = element;
      canvas.width = COTE;
      canvas.height = COTE;
      ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return;              // pas de contexte : le jeu reste jouable, sans dessin
      ctx.imageSmoothingEnabled = false;
      lireCouleurs();

      if (global.matchMedia) {
        var sombre = global.matchMedia('(prefers-color-scheme: dark)');
        var relire = function () { lireCouleurs(); dessiner(); };
        if (sombre.addEventListener) sombre.addEventListener('change', relire);
        else if (sombre.addListener) sombre.addListener(relire);
      }
    },

    /* Le plateau change à chaque partie : ses murs sont tirés au sort. */
    definirPlateau: function (nouveau) {
      plateau = nouveau;
      if (ctx) dessiner();
    },

    definirEtat: function (nouvel) {
      if (!ctx) return;
      etat.positions = nouvel.positions.slice();
      etat.jetonIndex = nouvel.jetonIndex;
      etat.selection = nouvel.selection;
      etat.resolu = nouvel.resolu;
      if (!anim) dessiner();
    },

    /* Le moteur a déjà déplacé la bulle : on rattrape visuellement. */
    animer: function (bulle, depuis, vers, direction) {
      if (!ctx) return;
      if (mouvementReduit()) { dessiner(); return; }
      var d = DECALAGES[direction];
      /* Durée constante : une bulle qui traverse le plateau met le même temps
         qu'une bulle qui avance d'une case. C'est donc la vitesse qui suit la
         distance, et non l'inverse — un long trajet est une ruée, pas un
         voyage. La traînée reste ce qui rend le trajet relisible. */
      var glisse = MS_COURSE;
      anim = {
        bulle: bulle, depuis: depuis, vers: vers,
        cases: Math.abs(M.colonne(vers) - M.colonne(depuis)) +
               Math.abs(M.ligne(vers) - M.ligne(depuis)),
        choque: false,
        dx: d.dx, dy: d.dy,
        debut: Date.now(), glisse: glisse, total: glisse + MS_IMPACT
      };
      lancer();
    },

    /* Coordonnées écran → case du plateau, ou -1 hors grille. */
    caseDepuisPoint: function (clientX, clientY) {
      if (!canvas) return -1;
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return -1;
      var x = Math.floor((clientX - r.left) / r.width * M.TAILLE);
      var y = Math.floor((clientY - r.top) / r.height * M.TAILLE);
      if (x < 0 || y < 0 || x >= M.TAILLE || y >= M.TAILLE) return -1;
      return M.index(x, y);
    },

    /* Une animation est-elle en cours ? Sert à mettre le coup suivant en
       file plutôt qu'à écraser celui qui court. */
    enMouvement: function () { return !!anim; },

    /* Rappel déclenché à la fin de chaque animation. */
    definirFinAnimation: function (cb) { surFin = cb; },

    /* Rappel déclenché à l'instant précis du choc, pas à la fin du coup. */
    definirImpact: function (cb) { surImpact = cb; },

    rafraichir: function () { lireCouleurs(); dessiner(); },
    dessiner: dessiner
  };

  global.PlateauPixel = API;

})(window.MoteurBulles, window);
