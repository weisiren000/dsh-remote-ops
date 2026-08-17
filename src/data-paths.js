import os from 'node:os'
import path from 'node:path'

export const DATA_DIR_NAME = 'remote-ssh-ops'

// 控制器与 hostd 共用同一目录名，避免后续改名产生两套持久化路径。
export function getDefaultControllerDataDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.dsh', DATA_DIR_NAME)
}

export function getDefaultHostdDataDir(homeDir = os.homedir()) {
  return path.join(getDefaultControllerDataDir(homeDir), 'hostd')
}
