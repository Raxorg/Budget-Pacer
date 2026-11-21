# Nuclear Pacer

Variante para Windows de Budget Pacer: monitor local de las cuotas de Codex con ventanas de cinco horas y siete días. Preparada para convivir como carpeta independiente junto a Groxar Pacer en el repositorio compartido.

## Requisitos y ejecución

Node.js 18 o posterior en PATH; no requiere npm install ni frameworks. La comprobación de esta preparación se registra aparte: no se ha probado una matriz completa de versiones de Node.

- Abrir con doble clic en **Iniciar Budget Pacer.cmd** para el navegador predeterminado.
- Abrir **Iniciar Budget Pacer - LibreWolf.cmd** para usar exclusivamente LibreWolf. Si no está instalado, se muestra un error; no se utiliza otro navegador.
- Mantener juntos todos los archivos de esta carpeta. Los CMD localizan su propia carpeta y no dependen de una letra de unidad ni del directorio de trabajo.
- Abrir mediante el iniciador, no directamente el HTML. La URL habitual es http://localhost:8787.

La carpeta de distribución se llama Nuclear Pacer; el título HTML y la identidad interna siguen siendo Budget Pacer para conservar la validación del iniciador. No se ha cambiado la marca interna ni la lógica funcional solo para empaquetar.

## Funcionamiento

Lee registros locales rollout-*.jsonl bajo CODEX_HOME/sessions o la carpeta .codex/sessions del usuario. No modifica esos registros ni muestra transcripciones. Identifica ventanas por duración y selecciona los eventos recientes de cada ventana. Conserva cuotas, tiempo restante, ritmo, proyecciones, fechas y cuenta regresiva. Si faltan datos o vencen, no supone un reinicio al 100 %.

El idioma de interfaz y formato regional proceden de Windows. Se admiten español e inglés; otros idiomas de interfaz usan inglés. Si falla la detección, se usan inglés y en-US. La zona horaria se obtiene por separado del sistema y no depende de la zona que el navegador exponga. Reiniciar el servidor después de cambiar el idioma de Windows.

El servidor escucha solo en 127.0.0.1. Se mantiene activo con actividad válida de una pestaña y se apaga tras cinco minutos de inactividad. Varias pestañas pueden mantenerlo vivo; las consultas de salud no prolongan el plazo. Los CMD reutilizan el mismo servidor de esta carpeta o lo reinician si ya terminó. Tras un reinicio, recargar pestañas antiguas. Una pestaña congelada por el navegador durante más de cinco minutos puede requerir abrir otra vez el iniciador.

## Credenciales y seguridad

Los iniciadores fuerzan BUDGET_PACER_ENABLE_RESETS=0. No se necesitan credenciales para leer las cuotas locales y no se incluyen archivos de autenticación en esta carpeta. La función opcional existente de consulta externa de reinicios está desactivada por defecto; activarla mediante BUDGET_PACER_ENABLE_RESETS=1 en un arranque manual leería auth.json y enviaría el token al endpoint HTTPS de uso de chatgpt.com. No está habilitada ni validada por esta preparación. No se incluye soporte de Claude.

La aplicación rechaza orígenes ajenos y valida la identidad local antes de abrir el navegador. No es un servidor público ni debe exponerse a la red.

## Convivencia con Groxar Pacer y otras copias

El puerto predeterminado es 8787 en ambas variantes. Guardarlas en carpetas distintas no permite ejecutarlas simultáneamente en el mismo puerto. Nuclear Pacer rechaza un ocupante sin su identidad o de otra carpeta; no termina procesos ajenos. También rechazará otra copia activa de Nuclear Pacer situada en una carpeta distinta.

Usar una variante a la vez, cerrando y esperando el apagado de la anterior. El VBS de Groxar puede abrir el servicio que ya ocupe 8787; este paquete no lo modifica. Para un puerto alternativo se puede iniciar manualmente el servidor con PORT y abrir esa URL; los CMD distribuidos mantienen 8787.

## Pruebas

Desde esta carpeta:

    node --test pacer.test.js launcher.test.js librewolf.test.js timezone.test.js localization.test.js lifecycle.test.js

Las pruebas utilizan fixtures dentro de la carpeta y puertos locales temporales, sin credenciales reales ni servicios externos. Incluyen selección de registros, errores, regionalización, iniciadores y apagado acelerado. No se incluye historial detallado ni análisis de eficiencia.

## Contribuciones

Mantener esta carpeta independiente de Groxar Pacer. No copiar aquí historiales .git, memorias privadas, credenciales, sesiones, registros, copias de seguridad o archivos temporales. Ver ORIGEN.md para la procedencia.
