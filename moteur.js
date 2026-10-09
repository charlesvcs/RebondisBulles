/* =========================================================================
   REBONDIS BULLES — MOTEUR
   Plateau, physique de glissade, solveur optimal.
   Logique pure : aucun accès au DOM. Utilisable tel quel dans un Worker.
   ========================================================================= */

(function (global) {
  'use strict';

  var TAILLE = 16;
  var COULEURS = ['rouge', 'vert', 'bleu', 'jaune'];

  var DIRECTIONS = {
    haut:   { dx: 0,  dy: -1, mur: 'top',    oppose: 'bottom' },
    droite: { dx: 1,  dy: 0,  mur: 'right',  oppose: 'left'   },
    bas:    { dx: 0,  dy: 1,  mur: 'bottom', oppose: 'top'    },
    gauche: { dx: -1, dy: 0,  mur: 'left',   oppose: 'right'  }
  };
  var NOMS_DIRECTIONS = ['haut', 'droite', 'bas', 'gauche'];

  /* Bloc central 2x2 infranchissable. */
  var CENTRE = [[7, 7], [7, 8], [8, 7], [8, 8]];

  /* -----------------------------------------------------------------------
     17 coins en "L", chacun portant un jeton.
     16 jetons = 4 couleurs × 4 formes, + 1 Vortex.
     Disposition propre au projet.
     ----------------------------------------------------------------------- */
  var JETONS = [
    { x: 2,  y: 1,  couleur: 'bleu',   forme: 'carre' },
    { x: 6,  y: 2,  couleur: 'vert',   forme: 'triangle'  },
    { x: 1,  y: 5,  couleur: 'jaune',  forme: 'etoile'    },
    { x: 4,  y: 6,  couleur: 'rouge',  forme: 'cercle'     },
    { x: 10, y: 1,  couleur: 'rouge',  forme: 'triangle'  },
    { x: 13, y: 3,  couleur: 'jaune',  forme: 'cercle'     },
    { x: 9,  y: 5,  couleur: 'bleu',   forme: 'etoile'    },
    { x: 14, y: 6,  couleur: 'vert',   forme: 'carre' },
    { x: 2,  y: 9,  couleur: 'vert',   forme: 'cercle'    },
    { x: 5,  y: 11, couleur: 'bleu',   forme: 'triangle'  },
    { x: 1,  y: 13, couleur: 'rouge',  forme: 'etoile'     },
    { x: 6,  y: 14, couleur: 'jaune',  forme: 'carre'    },
    { x: 11, y: 9,  couleur: 'jaune',  forme: 'triangle' },
    { x: 9,  y: 12, couleur: 'rouge',  forme: 'carre'     },
    { x: 14, y: 11, couleur: 'bleu',   forme: 'cercle'  },
    { x: 12, y: 14, couleur: 'vert',   forme: 'etoile'    },
    { x: 7,  y: 4,  couleur: 'vortex', forme: 'vortex' }
  ];

  /* Ancrages des murs de rebond : un mur d'une case, perpendiculaire au bord,
     posé à un décalage tiré au sort dans sa plage. Les plages sont disjointes
     pour que les murs ne se massent pas au même endroit. */
  var ANCRAGES_BORDS = [
    { bord: 'haut',   plage: [1, 4] },  { bord: 'haut',   plage: [6, 9] },  { bord: 'haut',   plage: [11, 14] },
    { bord: 'bas',    plage: [1, 4] },  { bord: 'bas',    plage: [6, 9] },  { bord: 'bas',    plage: [11, 14] },
    { bord: 'gauche', plage: [1, 4] },  { bord: 'gauche', plage: [6, 9] },  { bord: 'gauche', plage: [11, 14] },
    { bord: 'droite', plage: [1, 4] },  { bord: 'droite', plage: [6, 9] },  { bord: 'droite', plage: [11, 14] }
  ];

  /* Quadrants : les quatre jetons d'un même quadrant reçoivent quatre
     orientations distinctes, pour qu'aucun coin du plateau ne se retrouve
     avec tous ses murs tournés du même côté. */
  function quadrant(j) {
    return (j.x < 8 ? 0 : 1) + (j.y < 8 ? 0 : 2);
  }

  /* Les quatre orientations possibles d'un coin en "L". */
  var COINS = [
    ['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']
  ];

  var COTE_VERS_DIR = { top: 'haut', right: 'droite', bottom: 'bas', left: 'gauche' };

  /* Générateur reproductible : la même graine redonne exactement le même
     plateau. Indispensable, car le solveur tourne dans un Worker qui
     reconstruit le plateau de son côté. */
  function melangeur(graine) {
    var a = (graine >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function index(x, y) { return y * TAILLE + x; }
  function colonne(p) { return p % TAILLE; }
  function ligne(p) { return (p - (p % TAILLE)) / TAILLE; }

  function poserMur(cellules, x, y, cote) {
    cellules[index(x, y)][cote] = true;
    var d = DIRECTIONS[COTE_VERS_DIR[cote]];
    var nx = x + d.dx, ny = y + d.dy;
    if (nx >= 0 && ny >= 0 && nx < TAILLE && ny < TAILLE) {
      cellules[index(nx, ny)][d.oppose] = true;
    }
  }

  function nombreMurs(c) {
    return (c.top ? 1 : 0) + (c.right ? 1 : 0) + (c.bottom ? 1 : 0) + (c.left ? 1 : 0);
  }

  /* Un mur est refusé s'il porte une case — ou sa voisine — à trois côtés
     fermés. Sur quatre côtés, trois murs sont forcément consécutifs : c'est
     le "U" dont on ne veut pas, une impasse à sortie unique. */
  /* Les deux extrémités d'un segment de mur, en coordonnées de sommets de
     la grille (0..16). Deux murs qui partagent un sommet forment un angle
     ou un escalier : c'est ce qu'on interdit, hors des deux branches d'un
     même coin en "L". */
  function sommetsDuMur(x, y, cote) {
    if (cote === 'top')    return [[x, y], [x + 1, y]];
    if (cote === 'bottom') return [[x, y + 1], [x + 1, y + 1]];
    if (cote === 'left')   return [[x, y], [x, y + 1]];
    return [[x + 1, y], [x + 1, y + 1]];
  }

  function cleSommet(s) { return s[0] + ':' + s[1]; }

  function sommetsLibres(occupes, murs) {
    var propres = {};
    for (var i = 0; i < murs.length; i++) {
      var bouts = sommetsDuMur(murs[i][0], murs[i][1], murs[i][2]);
      for (var b = 0; b < 2; b++) {
        var k = cleSommet(bouts[b]);
        if (occupes[k]) return false;
        propres[k] = true;      // partagé entre les deux branches du L : toléré
      }
    }
    return propres;
  }

  function murAcceptable(cellules, x, y, cote) {
    var c = cellules[index(x, y)];
    if (c[cote]) return true;
    if (nombreMurs(c) >= 2) return false;
    var d = DIRECTIONS[COTE_VERS_DIR[cote]];
    var nx = x + d.dx, ny = y + d.dy;
    if (nx >= 0 && ny >= 0 && nx < TAILLE && ny < TAILLE) {
      var v = cellules[index(nx, ny)];
      if (!v[d.oppose] && nombreMurs(v) >= 2) return false;
    }
    return true;
  }

  function melanger(liste, rng) {
    var copie = liste.slice();
    for (var i = copie.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = copie[i]; copie[i] = copie[j]; copie[j] = t;
    }
    return copie;
  }

  /* Construit le plateau pour une graine donnée. Les emplacements des jetons
     sont fixes — ils sont répartis par quadrant — mais l'orientation de leur
     coin et la position des murs de bord sont tirées au sort. */
  function creerPlateau(graine) {
    for (var essai = 0; essai < 40; essai++) {
      var resultat = tenterPlateau(melangeur((graine >>> 0) + essai * 7919));
      if (resultat) { resultat.graine = graine >>> 0; return resultat; }
    }
    /* Repli : orientations imposées, jamais atteint en pratique. */
    return tenterPlateau(melangeur(1), true);
  }

  function tenterPlateau(rng, force) {
    var cellules = [];
    for (var i = 0; i < TAILLE * TAILLE; i++) {
      cellules.push({ top: false, right: false, bottom: false, left: false, bloquee: false });
    }
    var occupes = {};   // sommets déjà pris par un mur

    function enregistrer(murs) {
      murs.forEach(function (m) {
        poserMur(cellules, m[0], m[1], m[2]);
        sommetsDuMur(m[0], m[1], m[2]).forEach(function (b) { occupes[cleSommet(b)] = true; });
      });
    }

    /* Bords extérieurs. */
    for (var k = 0; k < TAILLE; k++) {
      cellules[index(k, 0)].top = true;
      cellules[index(k, TAILLE - 1)].bottom = true;
      cellules[index(0, k)].left = true;
      cellules[index(TAILLE - 1, k)].right = true;
    }

    /* Bloc central : infranchissable, et son pourtour occupe des sommets
       pour qu'aucun mur ne vienne s'y accrocher. */
    CENTRE.forEach(function (c) { cellules[index(c[0], c[1])].bloquee = true; });
    CENTRE.forEach(function (c) {
      NOMS_DIRECTIONS.forEach(function (nom) {
        var d = DIRECTIONS[nom];
        var nx = c[0] + d.dx, ny = c[1] + d.dy;
        var interne = CENTRE.some(function (o) { return o[0] === nx && o[1] === ny; });
        if (!interne) enregistrer([[c[0], c[1], d.mur]]);
      });
    });

    /* Murs de bord : un par ancrage, décalage tiré dans sa plage. */
    for (var a = 0; a < ANCRAGES_BORDS.length; a++) {
      var ancrage = ANCRAGES_BORDS[a];
      var offsets = melanger(plage(ancrage.plage), rng);
      var pose = false;
      for (var o = 0; o < offsets.length && !pose; o++) {
        var m = murDeBord(ancrage.bord, offsets[o]);
        var mur = [[m.x, m.y, m.cote]];
        if (murAcceptable(cellules, m.x, m.y, m.cote) && sommetsLibres(occupes, mur)) {
          enregistrer(mur);
          pose = true;
        }
      }
      if (!pose && !force) return null;
    }

    /* Coins des jetons. Chaque quadrant épuise les quatre orientations avant
       d'en réutiliser une : pas de coin du plateau uniformément orienté. */
    var reserves = {};
    var jetons = [];
    for (var j = 0; j < JETONS.length; j++) {
      var jeton = JETONS[j];
      var q = quadrant(jeton);
      if (!reserves[q] || !reserves[q].length) reserves[q] = melanger(COINS, rng);

      var retenu = null, rang = -1;
      for (var c2 = 0; c2 < reserves[q].length && !retenu; c2++) {
        var coin = reserves[q][c2];
        var murs = [[jeton.x, jeton.y, coin[0]], [jeton.x, jeton.y, coin[1]]];
        if (murAcceptable(cellules, jeton.x, jeton.y, coin[0]) &&
            murAcceptable(cellules, jeton.x, jeton.y, coin[1]) &&
            sommetsLibres(occupes, murs)) {
          retenu = coin; rang = c2;
        }
      }
      if (!retenu) {
        if (!force) return null;
        retenu = COINS[0]; rang = 0;
      }
      reserves[q].splice(rang, 1);
      enregistrer([[jeton.x, jeton.y, retenu[0]], [jeton.x, jeton.y, retenu[1]]]);
      jetons.push({
        x: jeton.x, y: jeton.y, couleur: jeton.couleur, forme: jeton.forme, murs: retenu
      });
    }

    var plateau = { taille: TAILLE, cellules: cellules, jetons: jetons };
    if (!force && casesIsolees(plateau).length) return null;
    if (!force && casesTroisMurs(plateau).length) return null;
    return plateau;
  }

  function plage(bornes) {
    var liste = [];
    for (var i = bornes[0]; i <= bornes[1]; i++) liste.push(i);
    return liste;
  }

  /* Un mur de bord est perpendiculaire à son bord et long d'une seule case. */
  function murDeBord(bord, decalage) {
    if (bord === 'haut')   return { x: decalage, y: 0, cote: 'right' };
    if (bord === 'bas')    return { x: decalage, y: TAILLE - 1, cote: 'right' };
    if (bord === 'gauche') return { x: 0, y: decalage, cote: 'bottom' };
    return { x: TAILLE - 1, y: decalage, cote: 'bottom' };
  }

  /* -----------------------------------------------------------------------
     Glissade : la bulle file jusqu'au premier obstacle et s'arrête juste
     avant. Obstacles : mur, bord, bloc central, autre bulle.
     ----------------------------------------------------------------------- */
  function glisserPosition(plateau, positions, bulle, direction) {
    var d = DIRECTIONS[direction];
    var p = positions[bulle];
    var x = colonne(p), y = ligne(p);

    for (;;) {
      if (plateau.cellules[index(x, y)][d.mur]) break;
      var nx = x + d.dx, ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= TAILLE || ny >= TAILLE) break;
      var suivante = plateau.cellules[index(nx, ny)];
      if (suivante.bloquee || suivante[d.oppose]) break;
      var np = index(nx, ny);
      var occupee = false;
      for (var j = 0; j < positions.length; j++) {
        if (j !== bulle && positions[j] === np) { occupee = true; break; }
      }
      if (occupee) break;
      x = nx; y = ny;
    }
    return index(x, y);
  }

  function glisser(plateau, bulles, bulle, direction) {
    var positions = bulles.map(function (b) { return index(b.x, b.y); });
    var p = glisserPosition(plateau, positions, bulle, direction);
    return { x: colonne(p), y: ligne(p) };
  }

  /* -----------------------------------------------------------------------
     SOLVEUR A*
     Deux optimisations rendent la recherche jusqu'à 13 coups tenable
     sur téléphone :

     1. Canonisation. Pour un jeton donné, seule l'identité de la bulle
        visée compte ; les trois autres sont interchangeables. On trie leurs
        positions, ce qui divise l'espace d'états par 3! = 6 (par 4! = 24
        pour le Vortex).

     2. Heuristique admissible. On calcule d'abord, sur 256 cases, la
        distance vers la case but dans un jeu relâché où une bulle peut
        s'arrêter n'importe où sur son rayon. Cette distance minore toujours
        le nombre réel de coups et ne varie que de 1 au plus par coup :
        A* avec file à seaux donne donc l'optimum exact, et l'élagage
        g + h > profondeur max coupe l'essentiel de l'arbre.
     ----------------------------------------------------------------------- */

  function paquetCle(a) {
    return (a[0] * 16777216 + a[1] * 65536 + a[2] * 256 + a[3]) >>> 0;
  }

  function EnsembleCles(bits) {
    var n = 1 << bits, m = n - 1, table = new Uint32Array(n);
    this.ajouter = function (k) {
      var i = (Math.imul(k, 2654435761) >>> 0) & m;
      while (table[i] !== 0) {
        if (table[i] === k) return false;
        i = (i + 1) & m;
      }
      table[i] = k;
      return true;
    };
  }

  /* Distances relâchées vers la case but. */
  function distancesRelachees(plateau, but) {
    var d = new Int16Array(TAILLE * TAILLE);
    d.fill(-1);
    d[but] = 0;
    var front = [but];
    while (front.length) {
      var suivant = [];
      for (var f = 0; f < front.length; f++) {
        var c = front[f];
        var x = colonne(c), y = ligne(c);
        for (var i = 0; i < 4; i++) {
          var dir = DIRECTIONS[NOMS_DIRECTIONS[i]];
          var cx = x, cy = y;
          for (;;) {
            if (plateau.cellules[index(cx, cy)][dir.mur]) break;
            var nx = cx + dir.dx, ny = cy + dir.dy;
            if (nx < 0 || ny < 0 || nx >= TAILLE || ny >= TAILLE) break;
            var voisine = plateau.cellules[index(nx, ny)];
            if (voisine.bloquee || voisine[dir.oppose]) break;
            cx = nx; cy = ny;
            var k = index(cx, cy);
            if (d[k] === -1) { d[k] = d[c] + 1; suivant.push(k); }
          }
        }
      }
      front = suivant;
    }
    return d;
  }

  function canoniser(positions, iCible) {
    if (iCible < 0) return positions.slice().sort(function (a, b) { return a - b; });
    var autres = [];
    for (var i = 0; i < 4; i++) if (i !== iCible) autres.push(positions[i]);
    autres.sort(function (a, b) { return a - b; });
    return [positions[iCible], autres[0], autres[1], autres[2]];
  }

  /* Tableau typé qui grandit tout seul. */
  function Tampon(Type, taille) {
    this.t = new Type(taille);
    this.n = 0;
    this.ajouter = function (v) {
      if (this.n === this.t.length) {
        var grand = new Type(this.t.length * 2);
        grand.set(this.t);
        this.t = grand;
      }
      this.t[this.n++] = v;
      return this.n - 1;
    };
  }

  /* Renvoie { optimal, chemin, etats }.
     optimal = -1 si aucune solution en profondeurMax coups ou moins.
     chemin  = [{ bulle, direction }, ...] avec les vrais indices de couleur. */
  function resoudre(plateau, positions, jeton, options) {
    options = options || {};
    var profMax = options.profondeurMax || 13;

    var vortex = jeton.couleur === 'vortex';
    var iCible = vortex ? -1 : COULEURS.indexOf(jeton.couleur);
    var but = index(jeton.x, jeton.y);
    var h = distancesRelachees(plateau, but);

    function estimer(s) {
      if (!vortex) return h[s[0]] < 0 ? 999 : h[s[0]];
      var m = 999;
      for (var i = 0; i < 4; i++) { var v = h[s[i]]; if (v >= 0 && v < m) m = v; }
      return m;
    }
    function atteint(s) {
      if (!vortex) return s[0] === but;
      return s[0] === but || s[1] === but || s[2] === but || s[3] === but;
    }

    var depart = canoniser(positions, iCible);
    if (atteint(depart)) return { optimal: 0, chemin: [], etats: 1 };

    var cles = new Tampon(Uint32Array, 1024);
    var parents = new Tampon(Int32Array, 1024);
    var couts = new Tampon(Uint8Array, 1024);
    var vus = new EnsembleCles(21);
    var seaux = [];

    function empiler(f, i) { (seaux[f] || (seaux[f] = [])).push(i); }

    var cleDepart = paquetCle(depart);
    vus.ajouter(cleDepart);
    cles.ajouter(cleDepart);
    parents.ajouter(-1);
    couts.ajouter(0);
    empiler(estimer(depart), 0);

    var s = [0, 0, 0, 0], fils = [0, 0, 0, 0], canon = [0, 0, 0, 0];
    var trouve = -1;

    for (var f = 0; f <= profMax && trouve < 0; f++) {
      var seau = seaux[f];
      if (!seau) continue;
      for (var q = 0; q < seau.length && trouve < 0; q++) {
        var noeud = seau[q];
        var k = cles.t[noeud], g = couts.t[noeud];
        s[0] = (k >>> 24) & 255; s[1] = (k >>> 16) & 255;
        s[2] = (k >>> 8) & 255;  s[3] = k & 255;

        for (var r = 0; r < 4 && trouve < 0; r++) {
          for (var di = 0; di < 4; di++) {
            var np = glisserPosition(plateau, s, r, NOMS_DIRECTIONS[di]);
            if (np === s[r]) continue;
            fils[0] = s[0]; fils[1] = s[1]; fils[2] = s[2]; fils[3] = s[3];
            fils[r] = np;

            if (vortex) {
              canon[0] = fils[0]; canon[1] = fils[1]; canon[2] = fils[2]; canon[3] = fils[3];
              canon.sort(function (a, b) { return a - b; });
            } else {
              var o1 = fils[1], o2 = fils[2], o3 = fils[3], t;
              if (o1 > o2) { t = o1; o1 = o2; o2 = t; }
              if (o2 > o3) { t = o2; o2 = o3; o3 = t; }
              if (o1 > o2) { t = o1; o1 = o2; o2 = t; }
              canon[0] = fils[0]; canon[1] = o1; canon[2] = o2; canon[3] = o3;
            }

            var ck = paquetCle(canon);
            if (!vus.ajouter(ck)) continue;
            var i = cles.ajouter(ck);
            parents.ajouter(noeud);
            couts.ajouter(g + 1);

            if (atteint(canon)) { trouve = i; break; }
            var nf = g + 1 + estimer(canon);
            if (nf <= profMax) empiler(nf, i);
          }
        }
      }
      seaux[f] = null;
    }

    if (trouve < 0) return { optimal: -1, chemin: null, etats: cles.n };

    /* Remontée des parents, puis traduction en coups réels. */
    var suite = [];
    for (var n = trouve; n !== -1; n = parents.t[n]) suite.push(cles.t[n]);
    suite.reverse();

    var reelles = positions.slice();
    var chemin = [];
    for (var e = 1; e < suite.length; e++) {
      var av = suite[e - 1], ap = suite[e];
      var avant = [(av >>> 24) & 255, (av >>> 16) & 255, (av >>> 8) & 255, av & 255];
      var apres = [(ap >>> 24) & 255, (ap >>> 16) & 255, (ap >>> 8) & 255, ap & 255];
      var depuis = avant.filter(function (v) { return apres.indexOf(v) === -1; })[0];
      var vers = apres.filter(function (v) { return avant.indexOf(v) === -1; })[0];
      var bulle = reelles.indexOf(depuis);
      var direction = null;
      for (var dj = 0; dj < 4; dj++) {
        if (glisserPosition(plateau, reelles, bulle, NOMS_DIRECTIONS[dj]) === vers) {
          direction = NOMS_DIRECTIONS[dj];
          break;
        }
      }
      if (bulle < 0 || !direction) return { optimal: couts.t[trouve], chemin: null, etats: cles.n };
      reelles[bulle] = vers;
      chemin.push({ bulle: bulle, direction: direction });
    }

    return { optimal: couts.t[trouve], chemin: chemin, etats: cles.n };
  }

  /* -----------------------------------------------------------------------
     Placement initial : hors du centre, hors des cases à jeton, sans
     superposition. Utilisé une seule fois par partie.
     ----------------------------------------------------------------------- */
  function placerBulles(plateau, rng) {
    rng = rng || Math.random;
    var interdites = new Set();
    plateau.cellules.forEach(function (c, i) { if (c.bloquee) interdites.add(i); });
    plateau.jetons.forEach(function (j) { interdites.add(index(j.x, j.y)); });

    var positions = [];
    while (positions.length < 4) {
      var p = Math.floor(rng() * TAILLE * TAILLE);
      if (interdites.has(p) || positions.indexOf(p) !== -1) continue;
      positions.push(p);
    }
    return positions;
  }

  /* Paquet des 17 jetons, mélangé (Fisher-Yates). */
  function melangerPaquet(rng) {
    rng = rng || Math.random;
    var paquet = JETONS.map(function (_, i) { return i; });
    for (var i = paquet.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = paquet[i]; paquet[i] = paquet[j]; paquet[j] = t;
    }
    return paquet;
  }

  /* Le jeton est-il déjà résolu par la position actuelle ? */
  function dejaPose(plateau, positions, jeton) {
    var but = index(jeton.x, jeton.y);
    if (jeton.couleur === 'vortex') return positions.indexOf(but) !== -1;
    return positions[COULEURS.indexOf(jeton.couleur)] === but;
  }

  /* Contrôle d'intégrité : aucune case jouable murée sur ses quatre côtés. */
  function casesIsolees(plateau) {
    var isolees = [];
    plateau.cellules.forEach(function (c, i) {
      if (c.bloquee) return;
      if (c.top && c.right && c.bottom && c.left) isolees.push(i);
    });
    return isolees;
  }

  /* Contrôle : aucune case jouable ne doit être fermée sur trois côtés. */
  function casesTroisMurs(plateau) {
    var liste = [];
    plateau.cellules.forEach(function (c, i) {
      if (!c.bloquee && nombreMurs(c) >= 3) liste.push(i);
    });
    return liste;
  }

  var API = {
    TAILLE: TAILLE,
    COULEURS: COULEURS,
    DIRECTIONS: DIRECTIONS,
    NOMS_DIRECTIONS: NOMS_DIRECTIONS,
    CENTRE: CENTRE,
    JETONS: JETONS,
    index: index,
    colonne: colonne,
    ligne: ligne,
    creerPlateau: creerPlateau,
    glisser: glisser,
    glisserPosition: glisserPosition,
    resoudre: resoudre,
    placerBulles: placerBulles,
    melangerPaquet: melangerPaquet,
    dejaPose: dejaPose,
    casesIsolees: casesIsolees,
    casesTroisMurs: casesTroisMurs,
    melangeur: melangeur
  };

  global.MoteurBulles = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof self !== 'undefined' ? self : this);
