// 視線挖洞：鏡頭拉低時，擋在鏡頭與焦點（以及選取的團）之間的城牆、門樓、塔、屋頂、樹冠淡到約三成，看得到後面的人。
// 做法比照樹冠變淡：抖動挖掉一部分像素（不用半透明排序）。每個洞是畫面上的一個圓（像素）加一個深度：
// 圓內、而且比目標離鏡頭近的建物像素才挖。陰影貼圖不受影響（牆的影子照舊）。
import * as THREE from 'three';

export const MAX_HOLES = 8;

export interface Hole {
  /** 畫面座標（CSS 像素，左上原點） */
  readonly x: number;
  readonly y: number;
  /** 半徑（CSS 像素） */
  readonly r: number;
  /** 目標離鏡頭的深度（鏡頭座標，格）；比這個近的才挖 */
  readonly depth: number;
}

export class SeeThrough {
  private readonly uniforms = {
    uHoles: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector4()) },
    uHoleN: { value: 0 },
    uHoleFade: { value: 0 },
  };

  /** 給建物、樹的材質加上挖洞（材質原有的 onBeforeCompile 照舊先跑） */
  patch(m: THREE.Material): void {
    const prev = m.onBeforeCompile.bind(m);
    const key = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform vec4 uHoles[${MAX_HOLES}];\nuniform int uHoleN;\nuniform float uHoleFade;`)
        .replace(
          '#include <clipping_planes_fragment>',
          [
            '#include <clipping_planes_fragment>',
            'if (uHoleN > 0) {',
            '  float hole = 0.0;',
            `  for (int i = 0; i < ${MAX_HOLES}; i++) {`,
            '    if (i >= uHoleN) break;',
            '    vec4 h = uHoles[i];',
            '    if (vViewPosition.z >= h.w) continue;',
            '    float d = length(gl_FragCoord.xy - h.xy);',
            '    hole = max(hole, 1.0 - smoothstep(h.z * 0.65, h.z, d));',
            '  }',
            '  if (hole > 0.0) {',
            '    int ix = int(mod(gl_FragCoord.x, 4.0));',
            '    int iy = int(mod(gl_FragCoord.y, 4.0));',
            '    float bm[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);',
            '    if ((bm[ix + iy * 4] + 0.5) / 16.0 < hole * uHoleFade) discard;',
            '  }',
            '}',
          ].join('\n'),
        );
    };
    m.customProgramCacheKey = () => `${key}|seeThrough`;
    m.needsUpdate = true;
  }

  /** 每格畫面設一次：洞（CSS 像素）、像素比、挖掉的比例（0 ＝ 不挖） */
  set(holes: readonly Hole[], pixelRatio: number, bufferHeight: number, fade: number): void {
    const u = this.uniforms;
    const n = Math.min(MAX_HOLES, holes.length);
    for (let i = 0; i < n; i++) {
      const h = holes[i];
      // gl_FragCoord 是繪圖緩衝的像素、左下原點
      u.uHoles.value[i].set(h.x * pixelRatio, bufferHeight - h.y * pixelRatio, h.r * pixelRatio, h.depth);
    }
    u.uHoleN.value = fade > 0 ? n : 0;
    u.uHoleFade.value = fade;
  }
}
