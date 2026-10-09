/* =========================================================================
   REBONDIS BULLES — RÉSEAU
   Liaison directe entre deux appareils du même réseau local, en WebRTC.
   Aucun serveur : les deux descriptions de session sont échangées à la main,
   une fois, sous forme de code court.

   Presque tout le SDP est du texte constant qu'on peut reconstruire des deux
   côtés. On ne transmet donc que ce qui est propre à la session — identifiants
   ICE, empreinte de la clé, rôle, candidats du réseau local — ce qui fait
   tomber 500 octets à environ 90 caractères, ou 220 avec des candidats mDNS.
   Vérifié sur une véritable poignée de main : la liaison s'établit avec ce
   seul code.
   ========================================================================= */

(function (global) {
  'use strict';

  var ATTENTE_ICE = 2500;      // au-delà, on part avec les candidats obtenus
  var MAX_CANDIDATS = 4;       // suffisant en local, garde le code court

  var pc = null, canal = null, role = null;
  var surMessage = null, surEtat = null;

  /* ------------------------------------------------------- CODEC --- */

  function hexVersB64(hex) {
    var bin = hex.split(':').map(function (h) {
      return String.fromCharCode(parseInt(h, 16));
    }).join('');
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64VersHex(b64) {
    var bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    var out = [];
    for (var i = 0; i < bin.length; i++) {
      out.push(('0' + bin.charCodeAt(i).toString(16)).slice(-2).toUpperCase());
    }
    return out.join(':');
  }

  function champ(sdp, motif) {
    var m = sdp.match(motif);
    return m ? m[1] : '';
  }

  function compacter(sdp) {
    var candidats = [];
    var re = /a=candidate:\S+ (\d+) (?:udp|UDP) \d+ (\S+) (\d+) typ host/g, m;
    while ((m = re.exec(sdp)) !== null && candidats.length < MAX_CANDIDATS) {
      if (m[1] !== '1') continue;                  // composante RTP seulement
      var cle = m[2] + ':' + m[3];
      if (candidats.indexOf(cle) === -1) candidats.push(cle);
    }
    return [
      champ(sdp, /a=setup:(\S+)/).charAt(0),
      champ(sdp, /a=ice-ufrag:(\S+)/),
      champ(sdp, /a=ice-pwd:(\S+)/),
      hexVersB64(champ(sdp, /a=fingerprint:sha-256 (\S+)/)),
      candidats.join(',')
    ].join('~');
  }

  var ROLES = { a: 'active', p: 'passive', c: 'actpass' };

  function etendre(code) {
    var p = code.split('~');
    if (p.length < 4) throw new Error('code illisible');
    var lignes = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'a=ice-options:trickle',
      'a=fingerprint:sha-256 ' + b64VersHex(p[3]),
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'a=mid:0',
      'a=sendrecv',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
      'a=setup:' + (ROLES[p[0]] || 'actpass'),
      'a=ice-ufrag:' + p[1],
      'a=ice-pwd:' + p[2]
    ];
    if (p[4]) {
      p[4].split(',').forEach(function (c, i) {
        var coupe = c.lastIndexOf(':');
        lignes.push('a=candidate:' + (i + 1) + ' 1 udp ' + (2122260223 - i) +
          ' ' + c.slice(0, coupe) + ' ' + c.slice(coupe + 1) + ' typ host');
      });
      lignes.push('a=end-of-candidates');
    }
    return lignes.join('\r\n') + '\r\n';
  }

  /* --------------------------------------------------- CONNEXION --- */

  function creerPair() {
    /* Aucun serveur STUN : on ne veut que les adresses du réseau local. */
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.oniceconnectionstatechange = function () {
      var e = pc.iceConnectionState;
      if (e === 'failed' || e === 'disconnected' || e === 'closed') etat('perdu');
    };
    return pc;
  }

  /* Les candidats ne peuvent pas être envoyés au fil de l'eau : on attend
     que la collecte soit close avant de fabriquer le code. */
  function attendreCandidats() {
    return new Promise(function (resoudre) {
      if (pc.iceGatheringState === 'complete') return resoudre();
      var fini = false;
      var terminer = function () {
        if (fini) return;
        fini = true;
        resoudre();
      };
      pc.onicegatheringstatechange = function () {
        if (pc.iceGatheringState === 'complete') terminer();
      };
      setTimeout(terminer, ATTENTE_ICE);
    });
  }

  function brancherCanal(c) {
    canal = c;
    canal.onopen = function () { etat('connecte'); };
    canal.onclose = function () { etat('perdu'); };
    canal.onmessage = function (ev) {
      if (!surMessage) return;
      try { surMessage(JSON.parse(ev.data)); } catch (e) { /* message illisible */ }
    };
  }

  function etat(e) { if (surEtat) surEtat(e); }

  var API = {
    disponible: function () {
      return typeof RTCPeerConnection !== 'undefined';
    },

    role: function () { return role; },
    connecte: function () { return !!canal && canal.readyState === 'open'; },

    surMessage: function (cb) { surMessage = cb; },
    surEtat: function (cb) { surEtat = cb; },

    /* Hôte : fabrique l'offre et renvoie le code à transmettre. */
    creerOffre: function () {
      role = 'hote';
      creerPair();
      brancherCanal(pc.createDataChannel('bulles', { ordered: true }));
      return pc.createOffer()
        .then(function (o) { return pc.setLocalDescription(o); })
        .then(attendreCandidats)
        .then(function () { return compacter(pc.localDescription.sdp); });
    },

    /* Invité : accepte l'offre et renvoie son code de réponse. */
    accepterOffre: function (code) {
      role = 'invite';
      creerPair();
      pc.ondatachannel = function (ev) { brancherCanal(ev.channel); };
      return pc.setRemoteDescription({ type: 'offer', sdp: etendre(code.trim()) })
        .then(function () { return pc.createAnswer(); })
        .then(function (r) { return pc.setLocalDescription(r); })
        .then(attendreCandidats)
        .then(function () { return compacter(pc.localDescription.sdp); });
    },

    /* Hôte : referme la poignée de main avec le code de l'invité. */
    accepterReponse: function (code) {
      return pc.setRemoteDescription({ type: 'answer', sdp: etendre(code.trim()) });
    },

    envoyer: function (objet) {
      if (!API.connecte()) return false;
      try { canal.send(JSON.stringify(objet)); return true; } catch (e) { return false; }
    },

    fermer: function () {
      try { if (canal) canal.close(); } catch (e) {}
      try { if (pc) pc.close(); } catch (e) {}
      canal = null; pc = null; role = null;
    },

    /* Exposés pour les tests et pour le partage par lien. */
    compacter: compacter,
    etendre: etendre
  };

  global.Reseau = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
