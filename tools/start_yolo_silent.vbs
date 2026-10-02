' ReJivan - Start YOLO Sentinel silently in the background (No terminal window)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
WshShell.CurrentDirectory = rootDir

' Prefer the project's local venv (CUDA torch + ultralytics).
venvPy = rootDir & "\.venv\Scripts\pythonw.exe"
If fso.FileExists(venvPy) Then
    pythonExe = """" & venvPy & """"
Else
    pythonExe = "pythonw.exe"
End If

WshShell.Run pythonExe & " """ & rootDir & "\tools\yolo_edge_sentinel.py""", 0, False
