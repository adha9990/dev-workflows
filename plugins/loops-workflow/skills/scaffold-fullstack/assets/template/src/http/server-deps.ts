import type { Logger } from '../ports/logger';
import type { NoteService } from '../services/note/note-service';

// HTTP 層所需的依賴契約。composition root(src/bin)
// 建構這些並交付進來,因此 create-server 保持與接線無關。
export interface ServerDeps {
  logger: Logger;
  noteService: NoteService;
  /** 設定後,SPA build 會從此目錄提供服務(single-process 模式)。 */
  clientDir?: string;
}
