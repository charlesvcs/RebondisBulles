/* =========================================================================
   REBONDIS BULLES — SON
   Tout est synthétisé à l'exécution avec Web Audio : aucun fichier audio,
   rien à mettre en cache, tout reste réglable.

   Parti pris sonore, calqué sur la direction artistique : sinus et triangle
   seulement — jamais de dent de scie ni de carré —, passe-bas systématique,
   et une gamme pentatonique, qui ne peut produire aucune dissonance.

   Muet par défaut. Les navigateurs interdisent de toute façon le son avant
   une action de l'utilisateur, et une page de portfolio ne doit pas se
   mettre à jouer toute seule.
   ========================================================================= */

(function (global) {
  'use strict';

  var CLE = 'bulles-son-v1';
  var ETATS = ['muet', 'effets', 'musique'];
  var LIBELLES = { muet: 'Muet', effets: 'Effets', musique: 'Musique' };

  /* Ré pentatonique majeure : ré, mi, fa#, la, si. */
  var GAMME = [293.66, 329.63, 369.99, 440.00, 493.88, 587.33, 659.25, 739.99, 880.00, 987.77];

  var etat = 'muet';
  var ctx = null;
  var maitre = null, busEffets = null, busMusique = null, echo = null;
  var bourdons = [], minuterie = null;

  function sombre() {
    return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /* ------------------------------------------------------ FABRIQUE --- */

  function demarrerContexte() {
    if (ctx) return true;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return false;
    try { ctx = new Ctx(); } catch (e) { return false; }

    maitre = ctx.createGain();
    maitre.gain.value = 1.0;

    /* Un passe-bas doux sur l'ensemble : la surface absorbe la lumière
       plutôt que de la renvoyer. */
    var doux = ctx.createBiquadFilter();
    doux.type = 'lowpass';
    doux.frequency.value = 5000;
    maitre.connect(doux);
    doux.connect(ctx.destination);

    /* Délai rebouclé en guise de réverbération : quelques nœuds au lieu
       d'un fichier d'impulsion. */
    echo = ctx.createDelay(1.0);
    echo.delayTime.value = 0.33;
    var retour = ctx.createGain();
    retour.gain.value = 0.28;
    var sortieEcho = ctx.createGain();
    sortieEcho.gain.value = 0.35;
    echo.connect(retour);
    retour.connect(echo);
    echo.connect(sortieEcho);
    sortieEcho.connect(maitre);

    busEffets = ctx.createGain();
    busEffets.gain.value = 1.0;
    busEffets.connect(maitre);
    busEffets.connect(echo);

    busMusique = ctx.createGain();
    busMusique.gain.value = 1.0;
    busMusique.connect(maitre);
    busMusique.connect(echo);

    return true;
  }

  /* Une note : oscillateur, enveloppe, filtre. */
  function note(options) {
    if (!ctx) return;
    var t0 = ctx.currentTime + (options.retard || 0);
    var osc = ctx.createOscillator();
    osc.type = options.forme || 'triangle';
    osc.frequency.setValueAtTime(options.frequence, t0);
    if (options.vers) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.vers), t0 + (options.chute || 0.08));
    }

    var enveloppe = ctx.createGain();
    var pic = options.volume === undefined ? 0.4 : options.volume;
    var attaque = options.attaque === undefined ? 0.004 : options.attaque;
    var duree = options.duree === undefined ? 0.18 : options.duree;
    enveloppe.gain.setValueAtTime(0.0001, t0);
    enveloppe.gain.exponentialRampToValueAtTime(pic, t0 + attaque);
    enveloppe.gain.exponentialRampToValueAtTime(0.0001, t0 + attaque + duree);

    var filtre = ctx.createBiquadFilter();
    filtre.type = 'lowpass';
    filtre.frequency.value = options.coupure || 2200;

    osc.connect(enveloppe);
    enveloppe.connect(filtre);
    filtre.connect(options.bus || busEffets);
    osc.start(t0);
    osc.stop(t0 + attaque + duree + 0.05);
  }

  /* Souffle très bref : donne au choc son corps, sans percussion sèche. */
  function souffle(volume, coupure) {
    if (!ctx) return;
    var n = Math.floor(ctx.sampleRate * 0.03);
    var tampon = ctx.createBuffer(1, n, ctx.sampleRate);
    var donnees = tampon.getChannelData(0);
    for (var i = 0; i < n; i++) donnees[i] = (Math.random() * 2 - 1) * (1 - i / n);

    var source = ctx.createBufferSource();
    source.buffer = tampon;
    var filtre = ctx.createBiquadFilter();
    filtre.type = 'bandpass';
    filtre.frequency.value = coupure || 1400;
    filtre.Q.value = 0.8;
    var g = ctx.createGain();
    g.gain.value = volume;
    source.connect(filtre);
    filtre.connect(g);
    g.connect(busEffets);
    source.start();
  }

  /* -------------------------------------------------------- NAPPE --- */

  function demarrerMusique() {
    if (!ctx || bourdons.length) return;
    var base = sombre() ? 73.42 : 146.83;   // ré, une octave plus bas au crépuscule

    [1, 1.5, 2.005].forEach(function (rapport, i) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * rapport;
      var g = ctx.createGain();
      g.gain.value = i === 0 ? 0.10 : 0.045;

      /* Respiration très lente du timbre. */
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.03 + i * 0.017;
      var profondeur = ctx.createGain();
      profondeur.gain.value = 0.02;
      lfo.connect(profondeur);
      profondeur.connect(g.gain);

      osc.connect(g);
      g.connect(busMusique);
      osc.start();
      lfo.start();
      bourdons.push(osc, lfo);
    });

    planifierNote();
  }

  /* Notes éparses, jamais deux fois le même intervalle : une nappe qui ne
     boucle pas plutôt qu'un motif qu'on finit par reconnaître. */
  function planifierNote() {
    var creux = sombre();
    var attente = (creux ? 4200 : 3000) + Math.random() * (creux ? 3500 : 3000);
    minuterie = setTimeout(function () {
      if (etat === 'musique' && ctx) {
        var choix = GAMME[Math.floor(Math.random() * GAMME.length)] * (creux ? 0.5 : 1);
        note({
          frequence: choix, forme: 'sine', volume: 0.07,
          attaque: 0.9, duree: 3.2, coupure: 1500, bus: busMusique
        });
        if (Math.random() < 0.35) {
          note({
            frequence: choix * 1.5, forme: 'sine', volume: 0.04, retard: 0.45,
            attaque: 1.0, duree: 3.0, coupure: 1400, bus: busMusique
          });
        }
      }
      planifierNote();
    }, attente);
  }

  function arreterMusique() {
    if (minuterie) { clearTimeout(minuterie); minuterie = null; }
    bourdons.forEach(function (o) { try { o.stop(); } catch (e) {} });
    bourdons = [];
  }

  function appliquerEtat() {
    if (!ctx) return;
    var cible = etat === 'musique' ? 0.12 : 0;
    busMusique.gain.setTargetAtTime(cible, ctx.currentTime, 0.8);
    if (etat === 'musique') demarrerMusique();
    else arreterMusique();
  }

  /* ---------------------------------------------------------- API --- */

  var API = {
    disponible: function () {
      return !!(global.AudioContext || global.webkitAudioContext);
    },

    etat: function () { return etat; },
    libelle: function () { return LIBELLES[etat]; },

    charger: function () {
      try {
        var v = localStorage.getItem(CLE);
        if (ETATS.indexOf(v) !== -1) etat = v;
      } catch (e) { /* stockage indisponible */ }
      return etat;
    },

    /* Appelé depuis un clic : c'est la seule occasion où le navigateur
       autorise l'ouverture du contexte audio. */
    cycler: function () {
      etat = ETATS[(ETATS.indexOf(etat) + 1) % ETATS.length];
      try { localStorage.setItem(CLE, etat); } catch (e) {}
      if (etat !== 'muet') {
        if (demarrerContexte() && ctx.state === 'suspended') ctx.resume();
      }
      appliquerEtat();
      if (etat !== 'muet') API.selection();
      return etat;
    },

    /* Choc contre l'obstacle. Plus la course est longue, plus le corps est
       lourd : la note descend et le souffle s'épaissit. */
    rebond: function (cases) {
      if (etat === 'muet' || !ctx) return;
      var poids = Math.min(cases || 1, 12) / 12;
      note({
        frequence: 520 - poids * 220, vers: 150 - poids * 40,
        chute: 0.07, forme: 'triangle',
        volume: 0.14 + poids * 0.06, attaque: 0.003, duree: 0.09, coupure: 1100
      });
      souffle(0.05 + poids * 0.03, 1600 - poids * 500);
    },

    selection: function () {
      if (etat === 'muet' || !ctx) return;
      note({ frequence: 880, forme: 'sine', volume: 0.06, duree: 0.05, coupure: 2400 });
    },

    /* Jeton posé, mais pas au mieux : deux notes, sobres. */
    reussite: function () {
      if (etat === 'muet' || !ctx) return;
      note({ frequence: 587.33, volume: 0.13, duree: 0.22 });
      note({ frequence: 880.00, volume: 0.11, retard: 0.10, duree: 0.30 });
    },

    /* Trajet optimal : quatre notes qui montent, avec l'octave en écho. */
    optimal: function () {
      if (etat === 'muet' || !ctx) return;
      [587.33, 739.99, 880.00, 1174.66].forEach(function (f, i) {
        note({ frequence: f, volume: 0.13 - i * 0.012, retard: i * 0.075, duree: 0.28, coupure: 2800 });
        note({ frequence: f * 2, forme: 'sine', volume: 0.04, retard: i * 0.075 + 0.02, duree: 0.22 });
      });
    },

    /* Temps écoulé sans réponse : deux notes qui descendent. */
    echec: function () {
      if (etat === 'muet' || !ctx) return;
      note({ frequence: 440, volume: 0.10, duree: 0.26, coupure: 1400 });
      note({ frequence: 293.66, volume: 0.09, retard: 0.13, duree: 0.40, coupure: 1200 });
    },

    suspendre: function () {
      if (ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) {} }
      if (minuterie) { clearTimeout(minuterie); minuterie = null; }
    },

    reprendre: function () {
      if (!ctx || etat === 'muet') return;
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      if (etat === 'musique' && !minuterie) planifierNote();
    }
  };

  global.Sons = API;

})(window);
