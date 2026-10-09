# Rebondis Bulles

Puzzle de glissade 16 × 16, jouable au doigt, installable comme application.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | la page (projet du portfolio + application) |
| `style.css` | direction artistique Horizon v3.0 |
| `moteur.js` | plateau, physique de glissade, solveur A* — aucun accès au DOM |
| `reseau.js` | liaison WebRTC pair à pair, codec des codes d'appairage |
| `sons.js` | banque sonore synthétisée, aucun fichier audio |
| `plateau.js` | rendu pixel art sur canvas, glissade et rebond |
| `interface.js` | entrées, déroulement de la partie |
| `solveur.js` | Worker : calcule l'objectif hors du fil principal |
| `sw.js` | service worker (hors ligne) |
| `manifest.webmanifest`, `icone*.svg` | installation sur l'écran d'accueil |

## Mise en ligne

Le service worker et le Worker exigent **http(s)** : en ouvrant `index.html`
depuis le disque (`file://`), le jeu fonctionne mais sans hors-ligne, et le
calcul de l'objectif retombe sur le fil principal.

En local :

```
python3 -m http.server 8000
```

puis `http://localhost:8000/`.

## À chaque livraison

Incrémenter `CACHE` dans `sw.js` (`bulles-v1` → `bulles-v2`). Sans ça, les
appareils qui ont déjà visité le site continueront de servir l'ancienne
version depuis leur cache.

## Le solveur

Deux optimisations rendent la recherche de l'optimum exact jusqu'à 13 coups
tenable sur téléphone :

- **canonisation** : pour un jeton donné, les trois bulles non visées sont
  interchangeables. Trier leurs positions divise l'espace d'états par 6
  (par 24 pour le Vortex) ;
- **heuristique admissible** : distance vers la case but dans un jeu relâché
  où une bulle peut s'arrêter n'importe où sur son rayon. Elle minore toujours
  le coût réel et ne varie que de 1 par coup, donc A* avec file à seaux rend
  l'optimum exact, et l'élagage `g + h > 13` coupe l'essentiel de l'arbre.

Mesuré sur machine de bureau : 20 ms par manche en moyenne, 440 ms dans le
pire cas, contre 5 600 ms pour un parcours en largeur classique.


## Le rendu

Le plateau est un canvas de 192 px de côté (16 cases de 12 px), agrandi en
`image-rendering: pixelated`. Les sprites sont des masques 8 × 8 déclarés en
haut de `plateau.js` : les modifier suffit à changer les formes.

Les jetons sont dessinés en contour, les bulles en disque plein — c'est ce qui
évite qu'un jeton rond soit pris pour une bulle de la même couleur. Les jetons
non tirés sont rapprochés du fond plutôt que rendus transparents, pour garder
des pixels francs.

Réglages de l'animation, en tête de `plateau.js` :

| Constante | Rôle | Valeur |
|---|---|---|
| `MS_COURSE` | durée d'une course, quelle que soit la distance | 55 ms |
| `MS_IMPACT` | durée de l'écrasement | 70 ms |
| `PLAQUAGE` | de combien le corps se plaque au mur | 2 px |
| `TRAINEE` | intensité de la traînée (0 = aucune) | 0.55 |

**La durée d'une course est constante**, une case ou quinze. C'est donc la
vitesse qui suit la distance : un long trajet est une ruée, pas un voyage.
De 218 px/s sur une case à 3 273 px/s en travers du plateau, soit environ
4,5 cases par image sur les trajets les plus longs — c'est la traînée qui
rend alors le trajet relisible.

**Toute l'énergie passe par la déformation, jamais par la position.** La bulle
part et s'arrête sans courbe, étirée dans l'axe
de sa course (10 × 6 px au lieu de 8 × 8). À l'impact elle se comprime dans ce
même axe (6 × 10) et se plaque contre l'obstacle, puis reprend sa forme. Elle
ne recule jamais : un rebond raconterait une collision élastique, alors qu'on
veut un corps qui encaisse.

Une traînée marque le trajet et s'efface avec le choc — elle rend la
trajectoire relisible après coup, ce qui sert le puzzle autant que le style.

Les sprites déformés `LARGE` et `HAUT` sont des masques dessinés à la main en
tête de `plateau.js`, l'un étant la transposée de l'autre. Pas de mise à
l'échelle : la grille de pixels reste intacte.

**Les coups s'enchaînent.** Une touche pressée pendant une course n'est pas
perdue : elle est mise en file et part à l'instant où la course s'achève.
C'est ce qui permet de jouer sans temps mort.

L'animation est purement visuelle : le moteur a déjà déplacé la bulle quand
elle démarre, donc rien ne dépend d'elle. `prefers-reduced-motion: reduce`
la désactive entièrement, et le reste du site n'a toujours aucune transition
ni animation CSS.


## Les deux modes

### Classique
Les 17 jetons du paquet, sans remise, sans limite de temps. Score = coups
joués et écart à la somme des optimaux. Au bout de 60 s sur une manche, le
bouton « Montrer la solution » se débloque.

### Rapide
Manches sans fin, une minute par jeton, chronométrée dès la révélation.

| Situation | Points | Solution montrée |
|---|---|---|
| Trajet optimal trouvé dans la minute | 1 + (temps restant / 60 s), donc jusqu'à 2 | oui |
| Réponse perfectible à l'expiration | optimal / coups joués | non |
| Aucune réponse à l'expiration | 0 | oui |

Une réponse perfectible ne clôt pas la manche : elle est enregistrée, le
plateau revient à sa position de départ et le joueur peut retenter dans le
temps restant. Seule sa meilleure réponse compte.

La **cadence** est le score retenu : points divisés par le nombre de manches,
chacune valant une minute pleine quel que soit le temps réellement passé
dessus. Elle vaut donc entre 0 et 2 pts/min. Compter le temps réel au
dénominateur paierait la vitesse deux fois — une fois par le bonus, une fois
par la division — et le classement se jouerait alors uniquement sur les
manches expédiées en quelques secondes.

Une partie interrompue en pleine manche ne compte pas la manche en cours. Le
classement local garde les cinq meilleures cadences avec le nombre de manches ;
à cadence égale, la partie la plus longue passe devant.

Constantes, en tête de `interface.js` :

| Constante | Rôle | Valeur |
|---|---|---|
| `LIMITE_MANCHE` | temps imparti en rapide | 60 000 ms |
| `DELAI_SOLUTION` | déblocage de la solution en classique | 60 000 ms |
| `MANCHES_CLASSIQUE` | longueur d'une partie classique | 17 |

Les scores vivent dans `localStorage` : `bulles-scores-v1` (classique),
`bulles-classement-v1` (rapide), `bulles-partie-v2` (partie en cours).


## Plateau aléatoire

Les emplacements des 17 jetons sont fixes — ils sont répartis par quadrant pour
garder un plateau équilibré — mais **l'orientation de chaque coin en « L » et
la position des huit murs de bord sont tirées au sort à chaque partie**.

Quatre règles encadrent le tirage :

1. **Pas de U.** Aucune case jouable fermée sur trois côtés — sur quatre côtés,
   trois murs sont forcément consécutifs, et la case devient une impasse à
   sortie unique.
2. **Pas de murs qui se touchent.** Deux segments ne peuvent pas partager un
   sommet de la grille, hors des deux branches d'un même coin. Sans cette
   règle, les murs forment des escaliers et des recoins qu'aucun plateau bien
   conçu ne comporte. Le pourtour du bloc central occupe lui aussi ses
   sommets : rien ne peut venir s'y accrocher.
3. **Quatre orientations par quadrant.** Les quatre jetons d'un même quadrant
   épuisent les quatre orientations avant qu'une seule soit réutilisée, ce qui
   interdit un coin de plateau dont tous les murs regardent du même côté.
4. **Douze murs de bord**, trois par bord, dans des plages disjointes.

Vérifié sur 400 graines : zéro U, zéro case isolée, zéro mur qui se touche,
quatre orientations distinctes dans chaque quadrant à chaque fois, 27 murs
verticaux et 27 horizontaux — exactement la densité du plateau fixe d'origine.

La graine du plateau est affichée dans le bloc technique : elle suffit à
rejouer un plateau à l'identique.

**La graine circule.** Le solveur tourne dans un Worker qui reconstruit le
plateau de son côté : chaque requête porte donc la graine, sans quoi il
résoudrait un autre plateau que celui affiché. Elle est également sauvegardée
avec la partie en cours. `creerPlateau(graine)` est reproductible : même
graine, mêmes murs.

## Objectif masqué

Le nombre de coups optimal s'affiche `?` tant que le joueur n'a rien proposé.
Il se révèle dès qu'une solution est posée, ou dès que la manche se clôt. En
mode rapide, c'est ce qui rend la relance utile : on découvre l'objectif en
même temps que l'écart qui reste à combler.

## Consultation de la solution

| Mode | Quand |
|---|---|
| Classique | après 60 s de réflexion, **ou** après avoir résolu la manche, pour la relire |
| Rapide | dès que la manche est close, quel que soit le verdict |

Si l'objectif dépasse la profondeur de recherche d'entrée (13 coups), le
bouton propose « Chercher la solution » et relance une recherche à 20 coups —
moins d'une seconde, dans le Worker. Il n'existe donc plus de cas où le joueur
reste devant un bouton mort.

## Retenter une manche

En classique, résoudre une manche ne la ferme pas : **Rejouer** la rouvre au
départ pour viser mieux, autant de fois qu'on veut. C'est **la meilleure
tentative** qui est retenue, jamais la dernière — retenter ne peut donc pas
faire perdre de points, et la position d'où repart la manche suivante est celle
de cette meilleure tentative. « Manche suivante » reste disponible dès qu'une
réponse existe, même en pleine nouvelle tentative.

Relire une solution ne modifie rien non plus : décompte et position sont figés
sur la meilleure réponse.


## Le son

Tout est synthétisé à l'exécution avec Web Audio : **aucun fichier audio**,
rien à mettre en cache, rien à licencier, et chaque paramètre reste réglable
dans `sons.js`.

Parti pris, calqué sur la direction artistique : sinus et triangle seulement —
jamais de dent de scie ni de carré —, passe-bas sur l'ensemble, et une gamme
**pentatonique** (ré, mi, fa#, la, si), qui ne peut produire aucune dissonance.
La réverbération est un simple délai rebouclé, quelques nœuds au lieu d'un
fichier d'impulsion.

| Événement | Son |
|---|---|
| Choc contre un obstacle | note descendante + souffle bref ; plus la course est longue, plus la note est grave et le souffle épais |
| Sélection d'une bulle | clic sinus très court |
| Jeton posé | deux notes montantes, sobres |
| Trajet optimal | quatre notes montantes, avec l'octave en écho |
| Temps écoulé sans réponse | deux notes descendantes |

La musique de fond n'est pas une boucle mais une **nappe générative** : trois
bourdons légèrement désaccordés avec une respiration très lente, et des notes
éparses tirées de la gamme toutes les 3 à 7 secondes, avec de longues attaques.
Rien ne se répète, donc rien ne lasse. **En mode sombre elle descend d'une
octave et se raréfie** — la même eau, vue au crépuscule.

**Muet par défaut**, avec trois états au bouton : Muet, Effets, Musique. Ce
n'est pas seulement une question de politesse : les navigateurs interdisent
tout son avant une action de l'utilisateur, et le contexte audio ne peut donc
s'ouvrir que sur ce clic. Le réglage est retenu d'une session à l'autre, et le
son se suspend quand l'onglet passe en arrière-plan.

Sur iPhone, l'interrupteur silencieux physique peut couper le son même en
mode application.


## Duel local

Deux appareils du même réseau, en WebRTC, **sans aucun serveur**.

### L'appairage

Deux navigateurs ne peuvent pas s'appeler directement : il faut échanger leurs
descriptions de session avant qu'un octet de jeu ne circule. Presque tout ce
SDP est du texte constant, reconstruit des deux côtés — on ne transmet que les
identifiants ICE, l'empreinte de la clé, le rôle et les candidats locaux. **500
octets tombent ainsi à 89 caractères**, ou environ 220 avec des candidats mDNS.
Vérifié sur une véritable poignée de main avec une pile WebRTC native : la
liaison s'établit avec ce seul code.

1. L'hôte crée la partie et obtient un lien.
2. Il l'envoie par AirDrop, iMessage ou n'importe quoi d'autre.
3. L'invité l'ouvre : le jeu démarre appairé et affiche un code de réponse.
4. L'invité renvoie ce code, l'hôte le colle. La liaison s'ouvre.

Le retour ne peut pas passer par un QR scanné à l'appareil photo : sur iPhone
cela ouvre Safari sur une page neuve, et l'hôte perdrait la clé de session
qu'il doit conserver pour terminer la poignée de main.

Aucun serveur STUN n'est déclaré : seules les adresses du réseau local sont
collectées. Si le routeur isole les clients entre eux ou bloque le multicast
mDNS, la liaison échouera — c'est la limite de cette approche.

### Les enchères

Le plateau, les bulles et le jeton sont identiques des deux côtés : seule la
graine circule, tout le reste se recalcule. **L'optimal reste masqué** jusqu'à
la fin de la manche.

1. Chacun annonce en combien de coups il pense y arriver. La première annonce
   ouvre une fenêtre de 30 secondes pendant laquelle on ne peut que baisser.
2. Le moins-disant démontre, avec 45 secondes et son nombre de coups pour
   plafond. Ses coups sont retransmis en direct sur l'autre appareil.
3. Dépasser son annonce, c'est échouer sur-le-champ : la main passe à l'autre
   joueur s'il avait annoncé.
4. La manche close, l'optimal est révélé et la solution consultable.

**L'hôte arbitre.** Lui seul décide des changements de phase et les diffuse :
deux horloges même légèrement décalées suffiraient sinon à faire diverger les
deux appareils sur le choix du démonstrateur.
