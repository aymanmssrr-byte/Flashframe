# Flash Frame

Tu déposes tes vidéos, l'app colle une image invisible sur les premières frames,
tu télécharges. C'est tout. Aucun réglage à l'écran.

L'image est tirée au hasard dans ta bibliothèque, que tu gères depuis l'app :
tu en mets vingt, chaque vidéo en reçoit une différente.

## À quoi ça sert

Le spectateur ne voit pas l'image consciemment, mais il sent que quelque chose
est passé et rembobine. Le replay rate est un des signaux les plus lourds de
l'algo Reels.

## Comment on s'en sert

1. Onglet **Mes images** → « Ajouter des images ». Tes visuels restent là
   définitivement, tu peux en ajouter ou en supprimer quand tu veux.
2. Onglet **Mes vidéos** → « Choisir mes vidéos ». Tu peux en sélectionner
   plusieurs d'un coup.
3. Tu attends la barre, tu télécharges.

Une seule vidéo → un `.mp4`. Plusieurs → un `.zip` avec les noms d'origine.

## Démarrer

```bash
docker build -t flashframe .
docker run -p 3000:3000 -v flashframe-data:/data flashframe
```

Puis `http://localhost:3000`, ou l'IP locale de la machine depuis le téléphone.

Le `-v flashframe-data:/data` est important : c'est là que vivent tes images.
Sans ça elles disparaissent à chaque redémarrage du conteneur.

En local sans Docker (ffmpeg doit être dans le PATH) :

```bash
npm install
npm start          # http://localhost:3000
npm test           # moteur ffmpeg
npm run test:api   # parcours HTTP complet
```

Sans `LIBRARY_DIR`, les images vont dans `./data/library`.

## Déploiement Railway

```bash
npm i -g @railway/cli
railway login
railway init            # ou : railway link  pour un projet existant
railway volume add --mount-path /data     # ← indispensable
railway up
railway domain          # génère l'URL publique
```

Railway détecte le `Dockerfile`. Le serveur écoute sur `process.env.PORT`, que
Railway injecte tout seul.

**Le volume sur `/data` n'est pas optionnel.** Sans lui, le système de fichiers
est éphémère : toute ta bibliothèque d'images repart à zéro au premier
redéploiement. Si le volume manque, l'app démarre quand même (elle bascule sur
un dossier local) et écrit un avertissement dans les logs.

Variables d'environnement, toutes optionnelles :

| Variable          | Défaut             | Rôle                                     |
|-------------------|--------------------|------------------------------------------|
| `PORT`            | `3000`             | port d'écoute                            |
| `LIBRARY_DIR`     | `/data/library`    | où vivent les images flash               |
| `WORK_DIR`        | `/tmp/flashframe`  | fichiers temporaires des vidéos          |
| `ADMIN_CODE`      | *(vide)*           | code d'accès à l'onglet « Mes images »   |
| `FLASH_FRAMES`    | `4`                | durée du flash, borné entre 3 et 8       |
| `MAX_IMAGES`      | `500`              | taille max de la bibliothèque            |
| `MAX_BATCH`       | `20`               | vidéos par envoi                         |
| `MAX_FILE_BYTES`  | `524288000`        | 500 Mo par vidéo                         |
| `JOB_TTL_MS`      | `3600000`          | durée de vie d'un job (1 h)              |

## Qui fait quoi

Deux rôles, un seul écran chacun.

**Toi** : onglet « Mes images ». Tu déposes tes visuels une fois, ils restent.
Si la variable `ADMIN_CODE` est définie, cet onglet demande ce code avant de
laisser ajouter ou supprimer quoi que ce soit.

**Celui qui utilise l'app** : onglet « Mes vidéos ». Il dépose une vidéo, c'est
tout. Il ne choisit aucune image, il n'en ajoute aucune — l'app pioche dans ta
bibliothèque toute seule.

Sans `ADMIN_CODE`, l'onglet images est ouvert à quiconque a l'URL. Définis-le
avant de partager le lien.

Attention : le code protège la bibliothèque, pas l'usage. N'importe qui avec
l'URL peut faire tourner des encodages sur ton serveur. Pour vendre l'app à
des clients, il faudra de vrais comptes séparés — chacun avec sa propre
bibliothèque. C'est le prochain vrai chantier.

## Ce que fait le traitement

`ffprobe` d'abord : dimensions, `r_frame_rate`, `color_transfer`, et la rotation
lue dans `side_data_list`. Ensuite une seule commande ffmpeg :

```
[0:v] fps=30
      [transpose conditionnel]
      [tonemap conditionnel]
      scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1 [base]
[1:v] scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1 [img]
[base][img] overlay=0:0:enable='between(n,1,4)' [v]
```

Sortie : h264 CRF 20 preset veryfast, maxrate 5M, yuv420p, AAC 128k 44,1 kHz,
`+faststart`, `-map 0:a?` pour ne pas planter sur une vidéo muette.

### Le flash se compte en frames, jamais en secondes

`between(n,1,4)` : le flash occupe les frames 1 à 4, et la frame 0 reste
intacte. Instagram utilise souvent la frame 0 comme vignette du Reel dans le
feed et sur le profil — un flash dessus donnerait une couverture illisible.

Le `fps=30` est placé **avant** l'overlay pour que `n` soit l'index de la frame
de sortie. Sans ça, une source en 24 ou 60 fps décalerait le flash.

### Pourquoi 4 frames et pas 1

Instagram réencode tout à l'upload. Une frame isolée est traitée comme du bruit
et lissée : le flash disparaît. 4 frames à 30 fps font 133 ms — assez pour
survivre au réencodage, trop court pour être lu consciemment. La valeur est
figée dans le code (`FLASH_FRAMES`), il n'y a rien à régler dans l'interface.

### Vidéos portrait iPhone

Elles sont stockées en paysage avec une matrice d'affichage. Si on la perd, la
vidéo sort couchée à 90° — c'est le bug le plus fréquent de ce genre d'outil.

Au démarrage, le serveur fabrique une vidéo 64×32 avec une rotation de 90°, la
décode, et regarde la taille obtenue. Si ffmpeg applique la rotation lui-même
(le cas de tous les builds récents), rien à faire. Sinon il passe
`-noautorotate` et ajoute un `transpose` déduit de `ffprobe`. Le résultat est
loggé au boot et exposé sur `GET /api/health`.

### HEVC / HDR iPhone

Si `color_transfer` vaut `arib-std-b67` (HLG) ou `smpte2084` (PQ), une
conversion directe vers h264 8 bits délave les couleurs. Dans ce cas seulement,
un tonemap vers bt709 est inséré. Sur une source SDR, rien n'est ajouté.

### Le tirage aléatoire

Un tirage purement aléatoire sortirait trois fois la même image sur cinq
vidéos. À la place, la bibliothèque est mélangée puis piochée sans remise, et
remélangée une fois épuisée : sur 3 images et 6 vidéos, chaque image sort
exactement 2 fois.

## API

| Route                          | Rôle                                             |
|--------------------------------|--------------------------------------------------|
| `GET /`                        | la page                                          |
| `GET /api/health`              | état, nombre d'images, capacités ffmpeg          |
| `GET /api/library`             | la liste des images                              |
| `POST /api/library`            | multipart `images` → ajoute à la bibliothèque    |
| `GET /api/library/:id/thumb`   | la vignette                                      |
| `DELETE /api/library/:id`      | supprime une image                               |
| `POST /api/jobs`               | multipart `videos` → lance le traitement         |
| `GET /api/progress/:id`        | SSE : `item`, `progress`, `itemDone`, `done`     |
| `GET /api/download/:id`        | le mp4 ou le zip, puis purge                     |

Le flux SSE rejoue son journal à la connexion : un téléphone qui se verrouille
pendant l'encodage coupe le flux, et l'app retrouve l'état exact au réveil.

## Fichiers et nettoyage

Les images de la bibliothèque sont permanentes. Les vidéos vivent dans
`WORK_DIR`, un dossier par job, supprimé une minute après le téléchargement (le
délai couvre les requêtes `Range` que Safari iOS peut réémettre) et au plus tard
une heure après l'envoi. Un balayage toutes les 5 minutes ramasse les dossiers
orphelins laissés par un redémarrage.

L'état des jobs en cours est en mémoire : un redémarrage perd les encodages en
cours, jamais les images.

## Tests

```bash
npm test        # 13 cas sur le moteur ffmpeg
npm run test:api  # 12 cas sur l'API et la bibliothèque
```

Le moteur est vérifié en décodant les frames de sortie et en comparant leurs
couleurs, pas en relisant la ligne de commande :

- position exacte du flash, à 3 et à 4 frames
- source 24 fps : le flash fait toujours 4 frames en sortie
- portrait stocké en paysage, rotation +90 et −90, chemin autorotation **et**
  chemin transpose manuel
- vidéo sans piste audio
- source HDR HLG et PQ : plus de marquage HDR en sortie, rouge non délavé
- image carrée : plein cadre, aucune bande noire

Côté API : ajout et suppression d'images, fichier corrompu ignoré sans planter,
refus explicite quand la bibliothèque est vide, encodage séquentiel vérifié par
compteur de concurrence, ZIP aux noms d'origine, équilibre du tirage aléatoire,
et survie de la bibliothèque à un redémarrage du serveur.

## Structure

```
src/ffmpeg.js      ffprobe, détection des capacités, filtre, encodage
src/library.js     la bibliothèque d'images et le tirage aléatoire
src/store.js       jobs en mémoire, SSE, TTL et balayage
src/server.js      les routes
public/index.html  toute l'app front, deux écrans
test/              moteur ffmpeg + parcours HTTP
```
