import { readFileSync, writeFileSync } from 'node:fs';
import { productPiece, pasteBack } from '/workspace/projects/34799c8e-8c8f-4178-89e7-3b7003b5a0f1/app/server/src/services/pasteback.ts';
import { cutoutImage } from '/workspace/projects/34799c8e-8c8f-4178-89e7-3b7003b5a0f1/app/server/src/services/matting.ts';
const T='/workspace/projects/34799c8e-8c8f-4178-89e7-3b7003b5a0f1/work/tpl/';
const pairs=[['core-white-main','digital'],['core-poster-headline','drink'],['core-drink-splash','drink'],['core-tech-desk','digital'],['sx-27911','beauty'],['core-velvet-jewel','jewelry'],['core-vanity','beauty']];
for (const [k,p] of pairs) {
  const t=Date.now();
  const piece=await productPiece(readFileSync(T+`products/${p}.jpg`));
  const r=await pasteBack(piece!, readFileSync(T+`samples/${k}.jpg`));
  console.log(k, r ? `iou=${r.iou.toFixed(3)} edge=${r.edge.toFixed(2)}` : 'skip', Date.now()-t,'ms');
  if (r) writeFileSync(`/tmp/pb/n_${k}.png`, r.data);
}
const t=Date.now(); writeFileSync('/tmp/pb/cut_drink.jpg', await cutoutImage(readFileSync(T+'products/drink.jpg'),{ratio:'1:1'})); console.log('cutout', Date.now()-t);
writeFileSync('/tmp/pb/cut_jew.png', await cutoutImage(readFileSync(T+'products/jewelry.jpg'),{transparent:true}));
