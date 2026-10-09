/* =========================================================================
   REBONDIS BULLES — SOLVEUR EN TÂCHE DE FOND
   Le calcul de l'objectif peut prendre jusqu'à ~1,5 s sur téléphone pour les
   jetons les plus profonds. Il tourne ici pour que le plateau reste réactif.

   Les murs étant tirés au sort, chaque requête porte la graine du plateau :
   sans elle, le solveur résoudrait un autre plateau que celui affiché.
   ========================================================================= */

importScripts('moteur.js');

var plateau = null;

self.onmessage = function (e) {
  var d = e.data;

  if (!plateau || plateau.graine !== d.graine) {
    plateau = MoteurBulles.creerPlateau(d.graine);
  }

  var resultat = MoteurBulles.resoudre(
    plateau,
    d.positions,
    plateau.jetons[d.jeton],
    { profondeurMax: d.profondeurMax || 13 }
  );

  self.postMessage({
    id: d.id,
    optimal: resultat.optimal,
    chemin: resultat.chemin
  });
};
