' Double-click to start Budget Pacer: no console window, opens the browser when the server is ready.
' The server shuts itself down shortly after the browser tab is closed.
Const PORT = 8787

Dim fso, sh, dir, http, i, ready
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' Start node hidden (window style 0). If a server is already running, the new one just exits (port in use).
On Error Resume Next
sh.Run "node """ & dir & "\pacer-server.js""", 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start Node.js. Is it installed and on your PATH?", 16, "Budget Pacer"
  WScript.Quit 1
End If
On Error GoTo 0

' Wait (up to ~10s) until the server answers, then open the page.
ready = False
For i = 1 To 40
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 500, 500
  http.Open "GET", "http://127.0.0.1:" & PORT & "/", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ready = True
  End If
  Err.Clear
  On Error GoTo 0
  If ready Then Exit For
  WScript.Sleep 250
Next

If ready Then
  sh.Run "http://localhost:" & PORT, 1, False
Else
  MsgBox "The Pacer server did not start. Try running 'node pacer-server.js' in a terminal to see the error.", 48, "Budget Pacer"
End If
