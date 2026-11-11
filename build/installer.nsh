; Puts the install folder (with db-viewer.cmd) on the user's PATH, and takes it off again on
; uninstall. PowerShell's SetEnvironmentVariable also tells open programs that PATH changed.
; In NSIS strings $$ is a literal $, so PowerShell variables are written $$name.

!macro customInstall
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR'.TrimEnd('\'); $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $$p) { $$p = '' }; $$parts = $$p -split ';' | Where-Object { $$_ } | ForEach-Object { $$_.TrimEnd('\') }; if ($$parts -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (($$p.TrimEnd(';') + ';' + $$d).TrimStart(';')), 'User') }"`
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new installer adds the folder again.
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR'.TrimEnd('\'); $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$p) { $$n = ($$p -split ';' | Where-Object { $$_ -and $$_.TrimEnd('\') -ne $$d }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $$n, 'User') }"`
!macroend
