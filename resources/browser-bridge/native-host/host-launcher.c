/*
 * macOS Chrome Native Messaging 启动器（Mach-O 可执行文件）
 * 放在 App 包 Contents/Helpers/ 下（与 Claude / 智谱等一致），Chrome 才能稳定拉起
 * HOST_SH_PATH 在 install 时由 -DHOST_SH_PATH= 注入
 */
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#ifndef HOST_SH_PATH
#define HOST_SH_PATH "/REPLACE/AT/INSTALL/host.sh"
#endif

static void debug_log(const char *msg) {
  const char *home = getenv("HOME");
  if (!home) return;
  char path[512];
  snprintf(path, sizeof(path), "%s/.sailfish-host.log", home);
  FILE *f = fopen(path, "a");
  if (!f) return;
  time_t now = time(NULL);
  struct tm tm;
  gmtime_r(&now, &tm);
  char ts[32];
  strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", &tm);
  fprintf(f, "%s launcher: %s\n", ts, msg);
  fclose(f);
}

int main(int argc, char *argv[]) {
  debug_log("Mach-O started, exec host.sh");
  if (argc >= 2) {
    execl("/bin/bash", "bash", HOST_SH_PATH, argv[1], NULL);
  } else {
    execl("/bin/bash", "bash", HOST_SH_PATH, NULL);
  }
  debug_log("execl failed");
  return 1;
}
