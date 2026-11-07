// Worker entry: the real worker global for serveFurnish (logic and tests in furnishWorker.ts).
import { serveFurnish, type FurnishScope } from './furnishWorker';

serveFurnish(self as unknown as FurnishScope);
