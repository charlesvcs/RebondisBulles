/* =========================================================================
   REBONDIS BULLES — INTERFACE
   Déroulement des parties, entrées, tableau de bord.
   Aucune règle de plateau ici : la physique et le solveur sont dans
   MoteurBulles, le dessin dans PlateauPixel.
   ========================================================================= */

(function (M) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var CLE_PARTIE = 'bulles-partie-v2';
  var CLE_SCORES = 'bulles-scores-v1';          // mode classique
  var CLE_CLASSEMENT = 'bulles-classement-v1';  // mode rapide
  var CLE_PSEUDO = 'bulles-pseudo-v1';

  var MANCHES_CLASSIQUE = 17;
  var DELAI_SOLUTION = 60000;   // classique : la solution se débloque après 60 s
  var LIMITE_MANCHE = 60000;    // rapide : temps imparti pour répondre
  var LIMITE_ANNONCE = 30000;   // duel : fenêtre d'enchères après la première annonce
  var LIMITE_DEMO = 45000;      // duel : temps pour démontrer son annonce
  var PROFONDEUR = 13;          // recherche d'entrée de manche
  var PROFONDEUR_MAX = 20;      // recherche approfondie, à la demande

  /* --------------------------------------------------------- FORMES --- */

  var FORMES = {
    cercle: '<circle cx="50" cy="50" r="34" fill="currentColor"/>',
    carre: '<rect x="17" y="17" width="66" height="66" rx="4" fill="currentColor"/>',
    triangle: '<polygon points="50,14 87,80 13,80" fill="currentColor"/>',
    etoile: '<polygon points="50,12 62,38 88,50 62,62 50,88 38,62 12,50 38,38" fill="currentColor"/>',
    vortex: [
      '<path d="M50 50 L50 16 A34 34 0 0 1 84 50 Z" fill="var(--jeu-rouge)"/>',
      '<path d="M50 50 L84 50 A34 34 0 0 1 50 84 Z" fill="var(--jeu-vert)"/>',
      '<path d="M50 50 L50 84 A34 34 0 0 1 16 50 Z" fill="var(--jeu-bleu)"/>',
      '<path d="M50 50 L16 50 A34 34 0 0 1 50 16 Z" fill="var(--jeu-jaune)"/>'
    ].join('')
  };

  var NOMS = { rouge: 'Rouge', vert: 'Verte', bleu: 'Bleue', jaune: 'Jaune', vortex: 'Vortex' };
  var NOMS_FORMES = { cercle: 'Cercle', carre: 'Carré', triangle: 'Triangle', etoile: 'Étoile' };
  var FLECHES = { haut: '↑', droite: '→', bas: '↓', gauche: '←' };

  function svgForme(jeton) {
    return '<svg viewBox="0 0 100 100" xmlns="' + NS + '" aria-hidden="true" ' +
      'style="color: var(--jeu-' + jeton.couleur + ')">' + FORMES[jeton.forme] + '</svg>';
  }

  function nomJeton(jeton) {
    if (jeton.couleur === 'vortex') return 'Vortex — n\'importe quelle bulle';
    return NOMS_FORMES[jeton.forme] + ' ' + NOMS[jeton.couleur];
  }

  /* ---------------------------------------------------------- ÉTAT --- */

  /* Reconstruit à chaque partie : les murs sont tirés au sort. */
  var plateau = M.creerPlateau(1);

  var jeu = {
    mode: 'classique',
    graine: 1,
    positions: [],
    departManche: [],
    positionsSuivantes: null,   // position d'où repartira la manche suivante
    paquet: [],
    jetonIndex: -1,
    manche: 0,
    coups: 0,
    historique: [],
    selection: 0,
    optimal: null,              // null = calcul en cours, -1 = plus de 13 coups
    chemin: null,
    resolu: false,              // la manche est close
    assistee: false,
    terminee: false,
    etapeSolution: 0,
    revele: false,              // l'objectif reste masqué tant qu'on n'a rien proposé
    rechercheProfonde: false,
    coupsRetenus: 0,            // score figé de la manche, insensible à la relecture

    /* classique */
    totalCoups: 0,
    totalOptimal: 0,
    coupsMesures: 0,
    manchesMesurees: 0,

    /* rapide */
    points: 0,
    manchesJouees: 0,
    tempsCompte: 0,             // temps de jeu seul, hors consultation des solutions
    meilleurCoups: null,        // meilleure réponse trouvée dans la manche
    meilleuresPositions: null,
    verdict: null
  };

  var chrono = { debut: 0, actif: false, timer: null, fige: 0 };
  var manche = { debut: 0, cumule: 0, timer: null, close: false };

  var el = {};
  var solveur = null;
  var demandeCourante = 0;

  function rapide() { return jeu.mode === 'rapide'; }
  function duel() { return jeu.mode === 'duel'; }
  function hote() { return Reseau.role() === 'hote'; }

  /* --------------------------------------------------------- DUEL ---
     L'hôte arbitre : lui seul décide des changements de phase et les
     annonce. L'invité n'émet que son enchère et ses coups. Sans cette
     autorité unique, deux horloges légèrement décalées suffiraient à faire
     diverger les deux appareils sur le choix du démonstrateur. */

  var d2 = {
    phase: 'appairage',     // appairage | annonce | demonstration | resultat
    monEnchere: 0,
    sonEnchere: 0,
    demonstrateur: null,    // 'moi' | 'lui'
    enchereDemo: 0,
    dejaTente: {},
    finPhase: 0,
    scoreMoi: 0,
    scoreLui: 0,
    proposition: 4
  };

  function moiCest() { return hote() ? 'hote' : 'invite'; }
  function lui() { return hote() ? 'invite' : 'hote'; }

  function envoyer(objet) { Reseau.envoyer(objet); }

  function duelNouvelleManche() {
    if (!hote()) return;
    jeu.graine = (Math.random() * 0x7FFFFFFF) >>> 0;
    plateau = M.creerPlateau(jeu.graine);
    PlateauPixel.definirPlateau(plateau);
    if (!jeu.positions.length) jeu.positions = M.placerBulles(plateau);
    if (!jeu.paquet.length) jeu.paquet = M.melangerPaquet();
    envoyer({
      t: 'manche', graine: jeu.graine, positions: jeu.positions,
      paquet: jeu.paquet, manche: jeu.manche + 1
    });
    duelDemarrerManche(jeu.graine, jeu.positions, jeu.paquet, jeu.manche + 1);
  }

  function duelDemarrerManche(graine, positions, paquet, numero) {
    jeu.graine = graine >>> 0;
    plateau = M.creerPlateau(jeu.graine);
    PlateauPixel.definirPlateau(plateau);
    jeu.positions = positions.slice();
    jeu.paquet = paquet.slice();
    jeu.manche = numero;

    var essais = 0;
    while (essais < jeu.paquet.length &&
           M.dejaPose(plateau, jeu.positions, plateau.jetons[jeu.paquet[0]])) {
      jeu.paquet.push(jeu.paquet.shift());
      essais++;
    }
    jeu.jetonIndex = jeu.paquet.shift();
    jeu.departManche = jeu.positions.slice();
    jeu.coups = 0;
    jeu.historique = [];
    jeu.resolu = false;
    jeu.revele = false;
    jeu.etapeSolution = 0;
    jeu.coupsRetenus = 0;
    jeu.selection = bulleParDefaut();
    manche.close = false;
    coupEnFile = null;

    d2.phase = 'annonce';
    d2.monEnchere = 0;
    d2.sonEnchere = 0;
    d2.demonstrateur = null;
    d2.dejaTente = {};
    d2.finPhase = 0;
    d2.proposition = 4;

    demarrerMinuteurManche(0);
    demanderObjectif();
    afficher();
    message('Manche ' + jeu.manche + '. Annonce en combien de coups tu penses y arriver.');
  }

  function duelAnnoncer() {
    if (d2.phase !== 'annonce') return;
    var v = d2.proposition;
    if (d2.monEnchere && v >= d2.monEnchere) return;   // on ne peut que baisser
    d2.monEnchere = v;
    envoyer({ t: 'enchere', valeur: v });
    if (!d2.finPhase) duelOuvrirFenetre();
    afficher();
    message('Tu annonces ' + v + ' coups.');
    Sons.selection();
  }

  function duelOuvrirFenetre() {
    d2.finPhase = Date.now() + LIMITE_ANNONCE;
    if (hote()) envoyer({ t: 'fenetre' });
  }

  /* Fin des enchères : l'hôte tranche et diffuse. */
  function duelClore() {
    if (!hote() || d2.phase !== 'annonce') return;
    var qui = null, valeur = 0;
    if (d2.monEnchere && d2.sonEnchere) {
      qui = d2.monEnchere <= d2.sonEnchere ? moiCest() : lui();
      valeur = Math.min(d2.monEnchere, d2.sonEnchere);
    } else if (d2.monEnchere) { qui = moiCest(); valeur = d2.monEnchere; }
    else if (d2.sonEnchere) { qui = lui(); valeur = d2.sonEnchere; }
    duelPhaseDemo(qui, valeur);
    envoyer({ t: 'demo', qui: qui, valeur: valeur });
  }

  function duelPhaseDemo(qui, valeur) {
    if (!qui) { duelResultat(null); envoyer({ t: 'resultat', gagnant: null, positions: jeu.positions }); return; }
    d2.phase = 'demonstration';
    d2.demonstrateur = (qui === moiCest()) ? 'moi' : 'lui';
    d2.enchereDemo = valeur;
    d2.dejaTente[qui] = true;
    d2.finPhase = Date.now() + LIMITE_DEMO;
    jeu.positions = jeu.departManche.slice();
    jeu.coups = 0;
    jeu.historique = [];
    afficher();
    message(d2.demonstrateur === 'moi'
      ? 'À toi de démontrer : ' + valeur + ' coups au maximum.'
      : 'L\'adversaire démontre en ' + valeur + ' coups.');
  }

  /* Le démonstrateur a échoué : on passe la main si l'autre avait annoncé. */
  function duelEchec() {
    if (!hote()) return;
    var autre = d2.demonstrateur === 'moi' ? lui() : moiCest();
    var enchereAutre = (autre === moiCest()) ? d2.monEnchere : d2.sonEnchere;
    if (enchereAutre && !d2.dejaTente[autre]) {
      duelPhaseDemo(autre, enchereAutre);
      envoyer({ t: 'demo', qui: autre, valeur: enchereAutre });
    } else {
      duelResultat(null);
      envoyer({ t: 'resultat', gagnant: null, positions: jeu.positions });
    }
  }

  function duelResultat(gagnant) {
    d2.phase = 'resultat';
    d2.finPhase = 0;
    jeu.resolu = true;
    jeu.revele = true;
    suspendreMinuteurManche();
    if (gagnant === moiCest()) { d2.scoreMoi++; Sons.optimal(); }
    else if (gagnant) { d2.scoreLui++; Sons.reussite(); }
    else Sons.echec();
    afficher();
    message(gagnant === moiCest() ? 'Manche gagnée.'
      : (gagnant ? 'Manche perdue.' : 'Personne n\'a tenu son annonce.'));
  }

  /* Coups reçus de l'adversaire pendant sa démonstration. */
  function duelCoupDistant(bulle, direction) {
    var depuis = jeu.positions[bulle];
    var arrivee = M.glisserPosition(plateau, jeu.positions, bulle, direction);
    if (arrivee === depuis) return;
    jeu.positions[bulle] = arrivee;
    jeu.selection = bulle;
    jeu.coups++;
    PlateauPixel.animer(bulle, depuis, arrivee, direction);
    afficher();
  }

  function duelRecevoir(m) {
    if (m.t === 'manche') { duelDemarrerManche(m.graine, m.positions, m.paquet, m.manche); return; }
    if (m.t === 'enchere') {
      d2.sonEnchere = m.valeur;
      if (!d2.finPhase) duelOuvrirFenetre();
      afficher();
      message('L\'adversaire annonce ' + m.valeur + ' coups.');
      return;
    }
    if (m.t === 'fenetre') { if (!d2.finPhase) d2.finPhase = Date.now() + LIMITE_ANNONCE; return; }
    if (m.t === 'demo') { duelPhaseDemo(m.qui, m.valeur); return; }
    if (m.t === 'coup') { duelCoupDistant(m.bulle, m.direction); return; }
    if (m.t === 'reussite') {
      jeu.positions = m.positions.slice();
      duelResultat(lui());
      return;
    }
    if (m.t === 'echec') { if (hote()) duelEchec(); return; }
    if (m.t === 'resultat') {
      if (m.positions) jeu.positions = m.positions.slice();
      duelResultat(m.gagnant);
      return;
    }
  }

  /* Battement du duel, appelé par le minuteur commun. */
  function duelBattre() {
    if (!duel() || !d2.finPhase || Date.now() < d2.finPhase) return;
    if (d2.phase === 'annonce') { d2.finPhase = 0; duelClore(); return; }
    if (d2.phase === 'demonstration') {
      d2.finPhase = 0;
      if (d2.demonstrateur === 'moi') { envoyer({ t: 'echec' }); if (hote()) duelEchec(); }
      else if (hote()) duelEchec();
    }
  }

  /* ------------------------------------------------- SOLVEUR ASYNC --- */

  function creerSolveur() {
    try {
      var source = self.SOURCE_SOLVEUR;
      if (source) {
        var blob = new Blob([source], { type: 'text/javascript' });
        return new Worker(URL.createObjectURL(blob));
      }
      return new Worker('solveur.js');
    } catch (e) {
      return null;   // repli : calcul sur le fil principal
    }
  }

  function demanderObjectif() {
    demandeCourante++;
    var id = demandeCourante;
    var positions = jeu.positions.slice();
    var jetonIndex = jeu.jetonIndex;

    jeu.optimal = null;
    jeu.chemin = null;
    afficher();

    lancerRecherche(id, positions, jetonIndex, PROFONDEUR);
  }

  function lancerRecherche(id, positions, jetonIndex, profondeur) {
    if (solveur) {
      solveur.postMessage({ id: id, graine: jeu.graine, positions: positions,
        jeton: jetonIndex, profondeurMax: profondeur });
      return;
    }
    setTimeout(function () {
      var r = M.resoudre(plateau, positions, plateau.jetons[jetonIndex], { profondeurMax: profondeur });
      recevoirObjectif(id, r.optimal, r.chemin);
    }, 20);
  }

  /* Au-delà de 13 coups, l'objectif d'entrée de manche renonce. Le joueur
     peut demander une recherche plus large : elle coûte moins d'une seconde
     et supprime le dernier cas où aucune solution n'est consultable. */
  function chercherPlusLoin() {
    if (jeu.chemin || jeu.rechercheProfonde) return;
    jeu.rechercheProfonde = true;
    demandeCourante++;
    lancerRecherche(demandeCourante, jeu.departManche.slice(), jeu.jetonIndex, PROFONDEUR_MAX);
    afficher();
    message('Recherche d\'une solution au-delà de ' + PROFONDEUR + ' coups…');
  }

  function recevoirObjectif(id, optimal, chemin) {
    if (id !== demandeCourante) return;     // réponse périmée
    var profonde = jeu.rechercheProfonde;
    jeu.rechercheProfonde = false;
    jeu.optimal = optimal;
    jeu.chemin = chemin;
    if (profonde) {
      message(chemin
        ? 'Solution trouvée en ' + optimal + ' coups.'
        : 'Aucune solution en moins de ' + PROFONDEUR_MAX + ' coups.');
    }
    /* Une réponse a pu être donnée avant que l'objectif ne revienne :
       on la juge maintenant. */
    if (rapide() && !manche.close && jeu.meilleurCoups !== null) evaluerReponse();
    afficher();
    sauvegarder();
  }

  /* ------------------------------------------------------- PARTIE --- */

  function nouvellePartie(mode) {
    if (mode) jeu.mode = mode;
    jeu.graine = (Math.random() * 0x7FFFFFFF) >>> 0;
    plateau = M.creerPlateau(jeu.graine);
    PlateauPixel.definirPlateau(plateau);
    jeu.positions = M.placerBulles(plateau);
    jeu.positionsSuivantes = null;
    jeu.paquet = M.melangerPaquet();
    jeu.manche = 0;
    jeu.terminee = false;
    jeu.totalCoups = 0;
    jeu.totalOptimal = 0;
    jeu.coupsMesures = 0;
    jeu.manchesMesurees = 0;
    jeu.points = 0;
    jeu.manchesJouees = 0;
    jeu.tempsCompte = 0;
    chrono.fige = 0;
    arreterChrono();
    el.recap.hidden = true;
    piocher();
  }

  function piocher() {
    if (!rapide() && !jeu.paquet.length) { terminerPartie(); return; }
    if (rapide() && !jeu.paquet.length) jeu.paquet = M.melangerPaquet();

    if (jeu.positionsSuivantes) {
      jeu.positions = jeu.positionsSuivantes.slice();
      jeu.positionsSuivantes = null;
    }

    /* Un jeton déjà satisfait par la position en cours ne ferait pas de
       manche : il repart sous le paquet. */
    var essais = 0;
    while (essais < jeu.paquet.length &&
           M.dejaPose(plateau, jeu.positions, plateau.jetons[jeu.paquet[0]])) {
      jeu.paquet.push(jeu.paquet.shift());
      essais++;
    }

    jeu.jetonIndex = jeu.paquet.shift();
    jeu.manche++;
    jeu.departManche = jeu.positions.slice();
    jeu.coups = 0;
    jeu.historique = [];
    jeu.resolu = false;
    jeu.assistee = false;
    jeu.etapeSolution = 0;
    jeu.revele = false;
    jeu.rechercheProfonde = false;
    jeu.coupsRetenus = 0;
    jeu.meilleurCoups = null;
    jeu.meilleuresPositions = null;
    jeu.verdict = null;
    jeu.selection = bulleParDefaut();
    manche.close = false;
    coupEnFile = null;

    demarrerMinuteurManche(0);
    demanderObjectif();

    if (rapide()) message('Manche ' + jeu.manche + '. Une minute pour trouver le meilleur trajet.');
    else message('Manche ' + jeu.manche + ' sur ' + MANCHES_CLASSIQUE + '. ' + texteAide());
  }

  function bulleParDefaut() {
    var jeton = plateau.jetons[jeu.jetonIndex];
    return jeton.couleur === 'vortex' ? (jeu.selection || 0) : M.COULEURS.indexOf(jeton.couleur);
  }

  function texteAide() {
    return estTactile()
      ? 'Fais glisser une bulle dans une direction.'
      : 'Choisis une bulle, puis lance-la avec les flèches.';
  }

  function rejouerManche() {
    if (jeu.terminee || manche.close) return;
    jeu.positions = jeu.departManche.slice();
    jeu.coups = 0;
    jeu.historique = [];
    jeu.etapeSolution = 0;
    /* Rouvrir la manche, sinon le plateau revient au départ mais reste gelé :
       deplacer() refuse tout coup tant que la manche est marquée résolue. */
    jeu.resolu = false;
    coupEnFile = null;
    demarrerMinuteurManche(manche.cumule);
    afficher();
    message(jeu.coupsRetenus
      ? 'Nouvelle tentative. Meilleure réponse jusqu\'ici : ' + jeu.coupsRetenus + ' coups.'
      : 'Position de départ de la manche rétablie.');
    sauvegarder();
  }

  function annuler() {
    if (!jeu.historique.length || jeu.terminee || manche.close) return;
    var avant = jeu.historique.pop();
    jeu.positions = avant.positions;
    jeu.selection = avant.selection;
    jeu.coups--;
    jeu.resolu = false;
    afficher();
    message('Coup annulé.');
    sauvegarder();
  }

  function mancheSuivante() {
    if (!jeu.resolu) return;
    if (!rapide()) {
      jeu.totalCoups += jeu.coupsRetenus;
      if (jeu.optimal > 0) {
        jeu.totalOptimal += jeu.optimal;
        jeu.coupsMesures += jeu.coupsRetenus;
        jeu.manchesMesurees++;
      }
    }
    piocher();
    sauvegarder();
  }

  /* --------------------------------------------------- DÉPLACEMENT --- */

  var coupEnFile = null;

  /* Un coup demandé pendant une course n'est pas perdu : il est mis en file
     et part à l'instant exact où la course s'achève. C'est ce qui permet
     d'enchaîner sans temps mort. */
  function deplacer(direction) {
    if (jeu.resolu || jeu.terminee || manche.close) return;
    if (duel() && !(d2.phase === 'demonstration' && d2.demonstrateur === 'moi')) return;
    if (PlateauPixel.enMouvement()) { coupEnFile = direction; return; }
    var arrivee = M.glisserPosition(plateau, jeu.positions, jeu.selection, direction);
    if (arrivee === jeu.positions[jeu.selection]) return;

    var depuis = jeu.positions[jeu.selection];
    jeu.historique.push({ positions: jeu.positions.slice(), selection: jeu.selection });
    jeu.positions[jeu.selection] = arrivee;
    jeu.coups++;
    PlateauPixel.animer(jeu.selection, depuis, arrivee, direction);
    if (duel()) envoyer({ t: 'coup', bulle: jeu.selection, direction: direction });
    demarrerChrono();
    vibrer(8);
    verifierVictoire();
    afficher();
    sauvegarder();
  }

  function verifierVictoire() {
    if (duel()) {
      if (d2.demonstrateur !== 'moi' || d2.phase !== 'demonstration') return;
      if (!M.dejaPose(plateau, jeu.positions, plateau.jetons[jeu.jetonIndex])) {
        /* Dépasser son annonce, c'est échouer immédiatement. */
        if (jeu.coups >= d2.enchereDemo) {
          envoyer({ t: 'echec' });
          if (hote()) duelEchec();
        }
        return;
      }
      envoyer({ t: 'reussite', coups: jeu.coups, positions: jeu.positions });
      duelResultat(moiCest());
      return;
    }
    if (!M.dejaPose(plateau, jeu.positions, plateau.jetons[jeu.jetonIndex])) return;

    if (!rapide()) {
      jeu.resolu = true;
      jeu.revele = true;
      /* Score et position d'arrivée figés sur la MEILLEURE tentative : relire
         la solution ou retenter moins bien ne doit ni changer le décompte,
         ni décaler la manche suivante. */
      var progres = !jeu.coupsRetenus || jeu.coups < jeu.coupsRetenus;
      if (progres) {
        jeu.coupsRetenus = jeu.coups;
        jeu.positionsSuivantes = jeu.positions.slice();
      }
      suspendreMinuteurManche();
      vibrer([10, 60, 10]);
      if (!jeu.assistee && jeu.optimal > 0 && jeu.coups === jeu.optimal) Sons.optimal();
      else Sons.reussite();
      var texte = 'Manche ' + jeu.manche + ' résolue en ' + jeu.coups + ' coup' +
        (jeu.coups > 1 ? 's' : '') + '. ';
      if (jeu.assistee) texte += 'Solution consultée.';
      else if (jeu.optimal > 0 && jeu.coups === jeu.optimal) texte += 'Optimal.';
      else if (jeu.optimal > 0) {
        texte += 'Optimal : ' + jeu.optimal + '. ';
        texte += progres ? 'Rejouer pour retenter.'
          : 'Meilleure réponse conservée : ' + jeu.coupsRetenus + '.';
      }
      texte += jeu.paquet.length
        ? ' ' + jeu.paquet.length + ' jeton' + (jeu.paquet.length > 1 ? 's' : '') + ' restant' +
          (jeu.paquet.length > 1 ? 's' : '') + '.'
        : ' Dernier jeton de la partie.';
      message(texte, 'resolu');
      return;
    }

    /* Mode rapide : la réponse est enregistrée, mais la manche reste ouverte
       tant que la minute n'est pas écoulée — le joueur peut viser mieux. */
    jeu.revele = true;
    Sons.reussite();
    if (jeu.meilleurCoups === null || jeu.coups < jeu.meilleurCoups) {
      jeu.meilleurCoups = jeu.coups;
      jeu.meilleuresPositions = jeu.positions.slice();
    }
    vibrer([10, 60, 10]);
    evaluerReponse();
  }

  /* Une réponse vient d'être posée : clôt la manche si elle est optimale,
     sinon remet le plateau en place pour une nouvelle tentative. */
  function evaluerReponse() {
    if (manche.close) return;
    if (jeu.optimal === null) {
      message('Réponse en ' + jeu.meilleurCoups + ' coups. Vérification en cours…');
      return;
    }
    var atteint = jeu.optimal < 0 ? true : jeu.meilleurCoups <= jeu.optimal;
    if (atteint) { cloturerManche('optimal'); return; }

    jeu.positions = jeu.departManche.slice();
    jeu.coups = 0;
    jeu.historique = [];
    PlateauPixel.definirEtat(etatRendu());
    message('Réponse en ' + jeu.meilleurCoups + ' coups enregistrée, l\'optimal est à ' +
      jeu.optimal + '. Encore ' + Math.ceil(resteManche() / 1000) + ' s pour faire mieux.');
  }

  function resteManche() {
    return Math.max(0, LIMITE_MANCHE - tempsManche());
  }

  function cloturerManche(verdict) {
    if (manche.close) return;
    manche.close = true;
    jeu.resolu = true;
    coupEnFile = null;
    jeu.revele = true;
    jeu.verdict = verdict;
    suspendreMinuteurManche();

    var duree = Math.min(tempsManche(), LIMITE_MANCHE);
    jeu.tempsCompte += duree;
    jeu.manchesJouees++;

    var gagnes = 0;
    if (verdict === 'optimal') {
      Sons.optimal();
      /* Point plein, plus un bonus au prorata du temps gagné sur la minute. */
      gagnes = 1 + Math.max(0, (LIMITE_MANCHE - duree) / LIMITE_MANCHE);
      jeu.positionsSuivantes = (jeu.meilleuresPositions || jeu.positions).slice();
      message('Optimal en ' + jeu.meilleurCoups + ' coups, ' + Math.round(duree / 1000) +
        ' s. +' + gagnes.toFixed(2) + ' points.', 'resolu');
    } else if (verdict === 'partiel') {
      Sons.reussite();
      /* Au prorata de la distance à l'optimal. */
      gagnes = jeu.optimal > 0 ? jeu.optimal / jeu.meilleurCoups : 1;
      jeu.positionsSuivantes = jeu.meilleuresPositions.slice();
      message('Temps écoulé. Meilleure réponse : ' + jeu.meilleurCoups + ' coups contre ' +
        jeu.optimal + ' possibles. +' + gagnes.toFixed(2) + ' point.', 'resolu');
    } else {
      Sons.echec();
      jeu.positionsSuivantes = jeu.departManche.slice();
      message('Temps écoulé, aucune réponse. La solution est à disposition, ' +
        'prends le temps de la regarder.', 'resolu');
    }
    jeu.points += gagnes;

    afficher();
    sauvegarder();
  }

  function finManche() {          // la minute s'épuise
    if (!rapide() || manche.close) return;
    cloturerManche(jeu.meilleurCoups === null ? 'zero' : 'partiel');
  }

  function terminerPartie() {
    jeu.terminee = true;
    suspendreMinuteurManche();
    arreterChrono();

    if (rapide()) {
      /* Une manche interrompue n'est ni comptée ni chronométrée : elle ne
         doit pas dégrader la cadence de la partie. */
      var score = {
        date: Date.now(),
        manches: jeu.manchesJouees,
        points: Math.round(jeu.points * 100) / 100,
        temps: jeu.tempsCompte,
        taux: Math.round(cadence() * 100) / 100,
        pseudo: pseudoEnregistre()
      };
      enregistrer(CLE_CLASSEMENT, score,
        function (a, b) { return b.taux - a.taux || b.manches - a.manches; });
      afficherRecapRapide(score);
    } else {
      var s = {
        date: Date.now(),
        coups: jeu.totalCoups,
        optimal: jeu.totalOptimal,
        coupsMesures: jeu.coupsMesures,
        manchesMesurees: jeu.manchesMesurees,
        temps: chrono.fige
      };
      enregistrer(CLE_SCORES, s,
        function (a, b) { return a.coups - b.coups || a.temps - b.temps; });
      afficherRecapClassique(s);
    }
    afficher();
    sauvegarder();
  }

  /* Cadence : chaque manche vaut une minute pleine, qu'elle ait été bouclée
     en cinq secondes ou en cinquante-neuf. La vitesse est déjà récompensée
     par le bonus ; la compter aussi au dénominateur la paierait deux fois et
     ferait exploser le classement sur les seules manches très courtes. */
  function cadence() {
    return jeu.manchesJouees > 0 ? jeu.points / jeu.manchesJouees : 0;
  }

  /* ----------------------------------------------------- SOLUTION --- */

  function avancerSolution() {
    if (!solutionAccessible()) return;
    if (!jeu.chemin) { chercherPlusLoin(); return; }
    jeu.assistee = true;
    jeu.revele = true;
    if (jeu.etapeSolution === 0) {
      jeu.positions = jeu.departManche.slice();
      jeu.coups = 0;
      jeu.historique = [];
    }
    var coup = jeu.chemin[jeu.etapeSolution];
    jeu.selection = coup.bulle;
    var origine = jeu.positions[coup.bulle];
    jeu.positions[coup.bulle] = M.glisserPosition(plateau, jeu.positions, coup.bulle, coup.direction);
    PlateauPixel.animer(coup.bulle, origine, jeu.positions[coup.bulle], coup.direction);
    jeu.coups++;
    jeu.etapeSolution++;

    if (rapide()) {
      /* Consultation libre : elle ne coûte ni temps compté, ni point. */
      afficher();
      message(jeu.etapeSolution >= jeu.chemin.length
        ? 'Solution complète en ' + jeu.chemin.length + ' coups.'
        : 'Solution ' + jeu.etapeSolution + '/' + jeu.chemin.length + ' : ' +
          NOMS[M.COULEURS[coup.bulle]] + ' ' + FLECHES[coup.direction] + '.');
      return;
    }

    verifierVictoire();
    afficher();
    if (!jeu.resolu) {
      message('Solution ' + jeu.etapeSolution + '/' + jeu.chemin.length + ' : ' +
        NOMS[M.COULEURS[coup.bulle]] + ' ' + FLECHES[coup.direction] + '.');
    }
    sauvegarder();
  }

  /* ----------------------------------------------------- MINUTEURS --- */

  function tempsManche() {
    return manche.cumule + (manche.debut ? Date.now() - manche.debut : 0);
  }

  function demarrerMinuteurManche(cumuleInitial) {
    arreterMinuteurManche();
    manche.cumule = cumuleInitial || 0;
    manche.debut = Date.now();
    manche.timer = setInterval(battre, 250);
    battre();
  }

  function suspendreMinuteurManche() {
    if (manche.debut) { manche.cumule += Date.now() - manche.debut; manche.debut = 0; }
    arreterMinuteurManche();
  }

  function arreterMinuteurManche() {
    if (manche.timer) { clearInterval(manche.timer); manche.timer = null; }
  }

  /* Battement commun : décompte du mode rapide, déblocage de la solution
     en classique. Il court dès la révélation du jeton, sans attendre un coup. */
  function battre() {
    duelBattre();
    if (rapide() && !manche.close && !jeu.terminee && tempsManche() >= LIMITE_MANCHE) {
      finManche();
      return;
    }
    majCompteurs();
    majSolution();
  }

  function demarrerChrono() {
    if (chrono.actif || jeu.terminee) return;
    chrono.actif = true;
    chrono.debut = Date.now() - chrono.fige;
    chrono.timer = setInterval(afficherChrono, 250);
  }

  function arreterChrono() {
    if (chrono.timer) clearInterval(chrono.timer);
    chrono.timer = null;
    if (chrono.actif) chrono.fige = Date.now() - chrono.debut;
    chrono.actif = false;
    afficherChrono();
  }

  function mmss(ms) {
    var s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function afficherChrono() {
    if (el.temps) el.temps.textContent = mmss(chrono.actif ? Date.now() - chrono.debut : chrono.fige);
  }

  function duree(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0');
  }

  /* Quand la solution peut-elle être consultée ?
     - rapide  : dès que la manche est close, quel qu'en soit le verdict ;
     - classique : après le délai de réflexion, ou après avoir résolu
       la manche, pour pouvoir la relire. */
  function solutionAccessible() {
    if (jeu.terminee) return false;
    if (rapide()) return manche.close;
    return jeu.resolu || tempsManche() >= DELAI_SOLUTION;
  }

  function majSolution() {
    var b = el.solution;
    if (jeu.terminee) { b.disabled = true; b.textContent = 'Montrer la solution'; return; }

    if (jeu.etapeSolution > 0 && jeu.chemin) {
      b.disabled = jeu.etapeSolution >= jeu.chemin.length;
      b.textContent = 'Solution ' + jeu.etapeSolution + '/' + jeu.chemin.length;
      return;
    }
    if (!solutionAccessible()) {
      b.disabled = true;
      if (rapide()) { b.textContent = 'Solution en fin de manche'; return; }
      var reste = Math.max(0, DELAI_SOLUTION - tempsManche());
      b.textContent = 'Solution dans ' + Math.ceil(reste / 1000) + ' s';
      return;
    }
    if (jeu.rechercheProfonde) { b.disabled = true; b.textContent = 'Recherche…'; return; }
    if (jeu.chemin) { b.disabled = false; b.textContent = 'Montrer la solution'; return; }
    if (jeu.optimal === null) { b.disabled = true; b.textContent = 'Solution — calcul…'; return; }
    /* Objectif hors de portée de la recherche d'entrée : on propose d'aller
       plus loin plutôt que de laisser le joueur devant un bouton mort. */
    b.disabled = false;
    b.textContent = 'Chercher la solution';
  }

  /* -------------------------------------------------------- SCORES --- */

  function lire(cle) {
    try {
      var brut = localStorage.getItem(cle);
      var liste = brut ? JSON.parse(brut) : [];
      return Array.isArray(liste) ? liste : [];
    } catch (e) { return []; }
  }

  function enregistrer(cle, score, tri) {
    try {
      var liste = lire(cle);
      liste.push(score);
      liste.sort(tri);
      localStorage.setItem(cle, JSON.stringify(liste.slice(0, 5)));
    } catch (e) { /* stockage indisponible */ }
  }

  function pseudoEnregistre() {
    try { return localStorage.getItem(CLE_PSEUDO) || ''; } catch (e) { return ''; }
  }

  /* Renomme l'entrée fraîchement enregistrée et retient le pseudo pour la
     prochaine partie. */
  function nommerScore(date, nom) {
    try {
      localStorage.setItem(CLE_PSEUDO, nom);
      var liste = lire(CLE_CLASSEMENT);
      liste.forEach(function (s) { if (s.date === date) s.pseudo = nom; });
      localStorage.setItem(CLE_CLASSEMENT, JSON.stringify(liste));
    } catch (e) { /* stockage indisponible */ }
  }

  function ligne(gauche, droite) {
    return '<div class="ligne"><span>' + gauche + '</span><span class="valeur">' + droite + '</span></div>';
  }

  function afficherRecapClassique(score) {
    var mesurees = score.manchesMesurees === undefined ? MANCHES_CLASSIQUE : score.manchesMesurees;
    var ecart = Math.max(0, (score.coupsMesures === undefined ? score.coups : score.coupsMesures) - score.optimal);
    var l = [ligne('Coups joués', score.coups), ligne('Écart à l\'optimal', '+' + ecart)];
    if (mesurees < MANCHES_CLASSIQUE) l.push(ligne('Manches mesurées', mesurees + '/' + MANCHES_CLASSIQUE));
    l.push(ligne('Temps', duree(score.temps)));

    var meilleurs = lire(CLE_SCORES);
    if (meilleurs.length > 1) {
      l.push('<div class="separateur"></div>');
      meilleurs.forEach(function (s, i) {
        l.push(ligne((i + 1) + '. ' + new Date(s.date).toLocaleDateString('fr-FR'),
          s.coups + ' coups · ' + duree(s.temps)));
      });
    }
    el.recap.innerHTML = l.join('');
    el.recap.hidden = false;
    message('Partie terminée : les ' + MANCHES_CLASSIQUE + ' jetons sont passés.', 'resolu');
  }

  function afficherRecapRapide(score) {
    var l = [
      ligne('Cadence', score.taux.toFixed(2) + ' pts/min'),
      ligne('Manches', score.manches),
      ligne('Points', score.points.toFixed(2)),
      ligne('Temps réel', duree(score.temps)),
      '<div class="separateur"></div>',
      '<label class="champ"><span>Ton pseudo</span>' +
        '<input id="pseudo" type="text" maxlength="16" autocomplete="nickname" ' +
        'value="' + echapper(score.pseudo || '') + '" placeholder="sans nom"></label>',
      '<div class="separateur"></div>',
      '<div id="classement"></div>'
    ];
    el.recap.innerHTML = l.join('');
    el.recap.hidden = false;
    dessinerClassement(score.date);

    var champ = document.getElementById('pseudo');
    champ.addEventListener('input', function () {
      nommerScore(score.date, champ.value.trim());
      dessinerClassement(score.date);
    });
    message('Partie rapide terminée.', 'resolu');
  }

  function dessinerClassement(dateCourante) {
    var cible = document.getElementById('classement');
    if (!cible) return;
    cible.innerHTML = lire(CLE_CLASSEMENT).map(function (s, i) {
      var nom = s.pseudo ? echapper(s.pseudo) : 'sans nom';
      return ligne((i + 1) + '. ' + nom + (s.date === dateCourante ? ' — cette partie' : ''),
        s.taux.toFixed(2) + ' pts/min · ' + s.manches + ' manches');
    }).join('');
  }

  function echapper(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------------------------------------------------- SAUVEGARDE --- */

  function sauvegarder() {
    try {
      localStorage.setItem(CLE_PARTIE, JSON.stringify({
        mode: jeu.mode, graine: jeu.graine, positions: jeu.positions, departManche: jeu.departManche,
        positionsSuivantes: jeu.positionsSuivantes, paquet: jeu.paquet,
        jetonIndex: jeu.jetonIndex, manche: jeu.manche, coups: jeu.coups,
        historique: jeu.historique, selection: jeu.selection, optimal: jeu.optimal,
        chemin: jeu.chemin, resolu: jeu.resolu, assistee: jeu.assistee,
        terminee: jeu.terminee, totalCoups: jeu.totalCoups, totalOptimal: jeu.totalOptimal,
        coupsMesures: jeu.coupsMesures, manchesMesurees: jeu.manchesMesurees,
        points: jeu.points, manchesJouees: jeu.manchesJouees, tempsCompte: jeu.tempsCompte,
        temps: chrono.actif ? Date.now() - chrono.debut : chrono.fige,
        tempsManche: tempsManche(), close: manche.close
      }));
    } catch (e) { /* stockage indisponible : pas de reprise */ }
  }

  function reprendre() {
    var brut = null;
    try { brut = localStorage.getItem(CLE_PARTIE); } catch (e) { return false; }
    if (!brut) return false;
    try {
      var s = JSON.parse(brut);
      if (!s || !Array.isArray(s.positions) || s.positions.length !== 4) return false;
      if (!Array.isArray(s.paquet) || !plateau.jetons[s.jetonIndex]) return false;
      if (s.terminee) return false;
      /* Une manche rapide close ne se reprend pas en l'état : son décompte
         est terminé. On repart proprement sur la manche suivante. */
      if (s.mode === 'rapide' && s.close) return false;

      jeu.mode = s.mode === 'rapide' ? 'rapide' : 'classique';
      /* Le plateau doit être reconstruit à l'identique avant toute lecture
         des positions : sans la graine, les murs ne seraient pas les mêmes. */
      jeu.graine = (s.graine >>> 0) || 1;
      plateau = M.creerPlateau(jeu.graine);
      PlateauPixel.definirPlateau(plateau);
      jeu.positions = s.positions.slice();
      jeu.departManche = (s.departManche || s.positions).slice();
      jeu.positionsSuivantes = s.positionsSuivantes || null;
      jeu.paquet = s.paquet.slice();
      jeu.jetonIndex = s.jetonIndex;
      jeu.manche = s.manche || 1;
      jeu.coups = s.coups || 0;
      jeu.historique = s.historique || [];
      jeu.selection = s.selection || 0;
      jeu.optimal = typeof s.optimal === 'number' ? s.optimal : null;
      jeu.chemin = s.chemin || null;
      jeu.resolu = !!s.resolu;
      jeu.assistee = !!s.assistee;
      jeu.totalCoups = s.totalCoups || 0;
      jeu.totalOptimal = s.totalOptimal || 0;
      jeu.coupsMesures = s.coupsMesures || 0;
      jeu.manchesMesurees = s.manchesMesurees || 0;
      jeu.points = s.points || 0;
      jeu.manchesJouees = s.manchesJouees || 0;
      jeu.tempsCompte = s.tempsCompte || 0;
      chrono.fige = s.temps || 0;
      manche.close = false;

      demarrerMinuteurManche(rapide() ? (s.tempsManche || 0) : (s.tempsManche || 0));
      if (jeu.optimal === null) demanderObjectif();
      afficher();
      message('Partie reprise — manche ' + jeu.manche + '.');
      return true;
    } catch (e) { return false; }
  }

  /* --------------------------------------------------------- RENDU --- */

  function etatRendu() {
    return {
      positions: jeu.positions,
      jetonIndex: jeu.jetonIndex,
      selection: jeu.selection,
      resolu: jeu.resolu
    };
  }

  function majCompteurs() {
    el.manche.textContent = rapide() ? jeu.manche : jeu.manche + '/' + MANCHES_CLASSIQUE;
    el.coups.textContent = jeu.coups;
    el.objectif.textContent = !jeu.revele ? '?'
      : (jeu.optimal === null ? '…' : (jeu.optimal < 0 ? PROFONDEUR + '+' : jeu.optimal));

    if (duel()) {
      el.restant.textContent = d2.finPhase
        ? Math.max(0, Math.ceil((d2.finPhase - Date.now()) / 1000)) + ' s' : '—';
      el.points.textContent = d2.scoreMoi;
      el.taux.textContent = d2.scoreLui;
      return;
    }
    if (rapide()) {
      el.restant.textContent = Math.ceil((manche.close ? 0 : resteManche()) / 1000) + ' s';
      el.points.textContent = jeu.points.toFixed(2);
      el.taux.textContent = cadence().toFixed(2);
    } else {
      afficherChrono();
    }
  }

  function afficher() {
    var jeton = plateau.jetons[jeu.jetonIndex];

    PlateauPixel.definirEtat(etatRendu());

    el.plateau.setAttribute('aria-label',
      'Plateau 16 par 16. Jeton : ' + nomJeton(jeton) +
      '. Bulle sélectionnée : ' + NOMS[M.COULEURS[jeu.selection]] + '.');

    el.compteurs.dataset.mode = jeu.mode === 'duel' ? 'rapide' : jeu.mode;
    afficherDuel();
    if (el.graine) el.graine.textContent = 'graine ' + jeu.graine;
    el.vignette.innerHTML = svgForme(jeton);
    el.libelleJeton.textContent = nomJeton(jeton);
    el.selection.textContent = NOMS[M.COULEURS[jeu.selection]];

    var bloque = jeu.terminee || manche.close;
    el.annuler.disabled = jeu.historique.length === 0 || bloque;
    el.rejouer.disabled = bloque;
    el.terminer.hidden = !rapide();
    el.terminer.disabled = jeu.terminee;
    el.suivante.disabled = duel()
      ? !(d2.phase === 'resultat' && hote())
      : (!jeu.terminee && !jeu.resolu && !(!rapide() && jeu.coupsRetenus > 0));
    el.suivante.textContent = jeu.terminee ? 'Nouvelle partie'
      : (rapide() || jeu.paquet.length ? 'Manche suivante' : 'Terminer la partie');

    Array.prototype.forEach.call(el.modes, function (b) {
      var actif = b.dataset.mode === jeu.mode;
      b.classList.toggle('actif', actif);
      b.setAttribute('aria-pressed', actif ? 'true' : 'false');
    });

    majCompteurs();
    majSolution();
  }

  function afficherDuel() {
    el.duel.hidden = !duel();
    if (!duel()) return;
    var relie = Reseau.connecte();
    el.duelAppairage.hidden = relie;
    el.duelPartie.hidden = !relie;
    if (!relie) return;

    el.duelScoreMoi.textContent = d2.scoreMoi;
    el.duelScoreLui.textContent = d2.scoreLui;
    el.duelAnnonce.hidden = d2.phase !== 'annonce';
    el.duelValeur.textContent = d2.proposition;
    el.duelAnnoncer.disabled = d2.monEnchere > 0 && d2.proposition >= d2.monEnchere;

    var reste = d2.finPhase ? Math.max(0, Math.ceil((d2.finPhase - Date.now()) / 1000)) : 0;
    if (d2.phase === 'annonce') {
      el.duelEtat.textContent = 'Annonces' +
        (d2.monEnchere ? ' · toi ' + d2.monEnchere : '') +
        (d2.sonEnchere ? ' · lui ' + d2.sonEnchere : '') +
        (d2.finPhase ? ' · ' + reste + ' s' : '');
    } else if (d2.phase === 'demonstration') {
      el.duelEtat.textContent = (d2.demonstrateur === 'moi' ? 'À toi' : 'À lui') +
        ' · ' + jeu.coups + '/' + d2.enchereDemo + ' coups · ' + reste + ' s';
    } else {
      el.duelEtat.textContent = 'Manche terminée';
    }
  }

  function message(texte, classe) {
    el.message.textContent = texte;
    el.message.className = 'message' + (classe ? ' ' + classe : '');
  }

  /* -------------------------------------------------------- ENTRÉES --- */

  var TOUCHES = {
    ArrowUp: 'haut', ArrowRight: 'droite', ArrowDown: 'bas', ArrowLeft: 'gauche',
    z: 'haut', d: 'droite', s: 'bas', q: 'gauche', w: 'gauche'
  };

  function estTactile() {
    return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  function selectionnerCase(pos) {
    var i = jeu.positions.indexOf(pos);
    if (i === -1) return false;
    jeu.selection = i;
    Sons.selection();
    afficher();
    return true;
  }

  function brancher() {
    el.plateau.addEventListener('click', function (ev) {
      selectionnerCase(PlateauPixel.caseDepuisPoint(ev.clientX, ev.clientY));
    });

    el.plateau.addEventListener('mousemove', function (ev) {
      var pos = PlateauPixel.caseDepuisPoint(ev.clientX, ev.clientY);
      el.plateau.style.cursor =
        (!jeu.resolu && jeu.positions.indexOf(pos) !== -1) ? 'pointer' : 'default';
    });

    var depart = null;
    el.plateau.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) { depart = null; return; }
      var t = ev.touches[0];
      depart = { x: t.clientX, y: t.clientY, pos: PlateauPixel.caseDepuisPoint(t.clientX, t.clientY) };
    }, { passive: true });

    el.plateau.addEventListener('touchend', function (ev) {
      if (!depart) return;
      var t = ev.changedTouches[0];
      var dx = t.clientX - depart.x, dy = t.clientY - depart.y;
      var ax = Math.abs(dx), ay = Math.abs(dy);
      var pos = depart.pos;
      depart = null;
      if (Math.max(ax, ay) < 20) { selectionnerCase(pos); return; }
      ev.preventDefault();
      selectionnerCase(pos);
      deplacer(ax > ay ? (dx > 0 ? 'droite' : 'gauche') : (dy > 0 ? 'bas' : 'haut'));
    }, { passive: false });

    document.addEventListener('keydown', function (ev) {
      var dir = TOUCHES[ev.key];
      if (dir) { ev.preventDefault(); deplacer(dir); return; }
      if (ev.key === 'Tab' && !ev.shiftKey && ev.target === document.body) {
        ev.preventDefault();
        jeu.selection = (jeu.selection + 1) % 4;
        afficher();
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-direction]'), function (b) {
      b.addEventListener('click', function () { deplacer(b.dataset.direction); });
    });

    Array.prototype.forEach.call(el.modes, function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.mode === jeu.mode) return;
        if (b.dataset.mode === 'duel') {
          jeu.mode = 'duel';
          d2.phase = 'appairage';
          afficher();
          message('Duel local : crée une partie ou rejoins celle de l\'autre joueur.');
          return;
        }
        nouvellePartie(b.dataset.mode);
        message(b.dataset.mode === 'rapide'
          ? 'Mode rapide : une minute par manche, cadence en points par minute.'
          : 'Mode classique : les ' + MANCHES_CLASSIQUE + ' jetons, sans limite de temps.');
      });
    });

    /* Appairage. L'hôte publie un lien, l'invité l'ouvre et renvoie un code
       que l'hôte colle : la poignée de main WebRTC a besoin des deux sens. */
    function montrerSortie(libelle, code) {
      el.duelLibelleSortie.textContent = libelle;
      el.duelSortie.value = code;
      el.duelChampSortie.hidden = false;
      el.duelActionsSortie.hidden = false;
    }
    function montrerEntree(libelle) {
      el.duelLibelleEntree.textContent = libelle;
      el.duelChampEntree.hidden = false;
      el.duelActionsEntree.hidden = false;
    }

    /* Les rejets de Reseau.* portent soit notre propre erreur ('code
       illisible', depuis reseau.js), soit une exception WebRTC/navigateur
       brute (SDP mal formé, décodage base64…) — jamais montrée telle
       quelle au joueur. */
    function raisonLiaison(e) {
      if (e && e.message === 'code illisible') {
        return 'trop court ou mal collé : copie-le en entier.';
      }
      return 'vérifie qu\'il est complet et colle-le depuis l\'autre appareil.';
    }

    el.duelCreer.addEventListener('click', function () {
      if (!Reseau.disponible()) { message('Ce navigateur ne gère pas la liaison directe.'); return; }
      message('Préparation de la liaison…');
      Reseau.creerOffre().then(function (code) {
        var lien = location.href.split('#')[0] + '#o=' + encodeURIComponent(code);
        montrerSortie('Envoie ce lien à l\'autre joueur', lien);
        montrerEntree('Colle ensuite le code qu\'il te renvoie');
        message('Envoie le lien, puis colle le code de réponse.');
      }).catch(function () { message('Liaison impossible : réessaie, ou vérifie que les deux appareils sont sur le même réseau.'); });
    });

    el.duelRejoindre.addEventListener('click', function () {
      montrerEntree('Colle le lien ou le code reçu');
      message('Colle le lien reçu, puis valide.');
    });

    el.duelValider.addEventListener('click', function () {
      var brut = el.duelEntree.value.trim();
      if (!brut) return;
      var code = brut.indexOf('#o=') !== -1
        ? decodeURIComponent(brut.split('#o=')[1]) : brut;
      if (Reseau.role() === 'hote') {
        Reseau.accepterReponse(code)
          .then(function () { message('Liaison en cours d\'établissement…'); })
          .catch(function (e) { message('Code refusé : ' + raisonLiaison(e)); });
      } else {
        Reseau.accepterOffre(code).then(function (reponse) {
          montrerSortie('Renvoie ce code à l\'hôte', reponse);
          message('Renvoie ce code à l\'hôte.');
        }).catch(function (e) { message('Code refusé : ' + raisonLiaison(e)); });
      }
    });

    el.duelCopier.addEventListener('click', function () {
      el.duelSortie.select();
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(el.duelSortie.value);
        else document.execCommand('copy');
        message('Copié.');
      } catch (e) { message('Copie impossible, sélectionne le texte à la main.'); }
    });

    el.duelMoins.addEventListener('click', function () {
      d2.proposition = Math.max(1, d2.proposition - 1); afficher();
    });
    el.duelPlus.addEventListener('click', function () {
      d2.proposition = Math.min(30, d2.proposition + 1); afficher();
    });
    el.duelAnnoncer.addEventListener('click', duelAnnoncer);

    el.annuler.addEventListener('click', annuler);
    el.rejouer.addEventListener('click', rejouerManche);
    el.solution.addEventListener('click', avancerSolution);
    el.terminer.addEventListener('click', function () { if (!jeu.terminee) terminerPartie(); });
    el.suivante.addEventListener('click', function () {
      if (duel()) { if (hote()) duelNouvelleManche(); return; }
      if (jeu.terminee) { el.recap.hidden = true; nouvellePartie(); }
      else mancheSuivante();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        arreterChrono();
        suspendreMinuteurManche();
        Sons.suspendre();
        sauvegarder();
      } else {
        Sons.reprendre();
        if (!jeu.terminee && !manche.close && !jeu.resolu) demarrerMinuteurManche(manche.cumule);
      }
    });
  }

  function vibrer(motif) {
    if (navigator.vibrate) { try { navigator.vibrate(motif); } catch (e) {} }
  }

  /* ------------------------------------------------------ DÉMARRAGE --- */

  document.addEventListener('DOMContentLoaded', function () {
    ['plateau', 'vignette', 'libelle-jeton', 'compteurs', 'manche', 'coups', 'objectif',
     'temps', 'restant', 'points', 'taux', 'selection', 'message', 'recap',
     'annuler', 'rejouer', 'solution', 'terminer', 'suivante', 'graine', 'son',
     'duel', 'duel-appairage', 'duel-partie', 'duel-creer', 'duel-rejoindre',
     'duel-sortie', 'duel-entree', 'duel-copier', 'duel-valider', 'duel-etat',
     'duel-score-moi', 'duel-score-lui', 'duel-annonce', 'duel-valeur',
     'duel-moins', 'duel-plus', 'duel-annoncer', 'duel-champ-sortie',
     'duel-champ-entree', 'duel-actions-sortie', 'duel-actions-entree',
     'duel-libelle-sortie', 'duel-libelle-entree']
      .forEach(function (id) {
        el[id.replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] =
          document.getElementById(id);
      });
    el.modes = document.querySelectorAll('[data-mode]');

    solveur = creerSolveur();
    if (solveur) {
      solveur.onmessage = function (e) {
        recevoirObjectif(e.data.id, e.data.optimal, e.data.chemin);
      };
      solveur.onerror = function () { solveur = null; };
    }

    Reseau.surMessage(duelRecevoir);
    Reseau.surEtat(function (e) {
      if (e === 'connecte') {
        message('Liaison établie.');
        Sons.optimal();
        if (hote()) { jeu.manche = 0; jeu.positions = []; jeu.paquet = []; duelNouvelleManche(); }
      } else if (e === 'perdu') {
        message('Liaison perdue.');
      }
      afficher();
    });

    /* Lien d'invitation ouvert : on préremplit et on bascule en duel. */
    var invitation = location.hash.indexOf('#o=') === 0
      ? decodeURIComponent(location.hash.slice(3)) : null;

    PlateauPixel.init(el.plateau, plateau);
    Sons.charger();
    el.son.textContent = Sons.libelle();
    el.son.disabled = !Sons.disponible();
    el.son.addEventListener('click', function () {
      Sons.cycler();
      el.son.textContent = Sons.libelle();
    });

    PlateauPixel.definirImpact(function (cases) { Sons.rebond(cases); });
    PlateauPixel.definirFinAnimation(function () {
      var suivant = coupEnFile;
      coupEnFile = null;
      if (suivant) deplacer(suivant);
    });
    if (!reprendre()) nouvellePartie();
    brancher();

    if (invitation) {
      jeu.mode = 'duel';
      d2.phase = 'appairage';
      afficher();
      el.duelChampEntree.hidden = false;
      el.duelActionsEntree.hidden = false;
      el.duelEntree.value = invitation;
      message('Invitation reçue. Valide pour obtenir ton code de réponse.');
    }

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  });

})(window.MoteurBulles);
