// 設計稿 D：舞台、燈下浮塵
import { dust, initStage } from './stage.ts';

initStage();
dust(document.getElementById('dust') as HTMLCanvasElement, ['rgba(255,226,170,.45)', 'rgba(255,240,210,.3)'], 50);
