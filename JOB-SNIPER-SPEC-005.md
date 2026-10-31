# SPEC 005 — Telegram legível, fila persistente e controle de cota

## Missão

Melhorar o uso diário do Job Sniper: mensagens organizadas em português, análise e proposta completas, mais oportunidades guardadas e chamadas ao Gemini dentro dos limites observados. Entregar incrementalmente no projeto existente, sem dashboard nesta SPEC.

Don Bruno é o dono do produto; Tony é o Tech Lead; Khalid executa no repositório local.

## 1. RECON curto e checkpoint

- Leia CLAUDE.md, STATUS.md, README, scripts e os módulos envolvidos. Confirme o estado real antes de editar.
- A SPEC 004 foi aprovada para commit na conversa. Se o checkpoint já existe, informe o hash. Se ainda não existe, conclua somente esse commit previamente autorizado, revisando o staging e preservando alterações alheias. Não invente hash nem faça push.
- Preserve SQLite, oportunidades, histórico de análises, propostas e confirmações de envio. Faça backup local ignorado pelo Git antes de migrar o banco.
- Inspecione a fila, a seleção para IA, o transporte Gemini e o notificador existentes. Reaproveite-os. Nada de nova infraestrutura, framework de agentes ou documentação extensa.

## 2. Telegram: informação organizada

A interface do Telegram passa a ser pt-BR, por decisão explícita do Don. Ajuste eventual regra conflitante no CLAUDE.md apenas nesse escopo; código e logs técnicos podem continuar em inglês.

Para cada oportunidade elegível, envie primeiro um resumo e depois os detalhes, incluindo a proposta completa quando houver um rascunho válido. Use títulos em negrito, linhas em branco e poucos emojis funcionais. Não misture títulos em inglês com conteúdo em português.

### Mensagem de resumo — referência visual

🟡 VALE REVISAR
Landing Page para o PREDPACK
📍 99Freelas

💰 Preço sugerido: R$ 600–1.250
⏱ Esforço estimado: 12–25 horas
🧩 Complexidade: média
🎯 Compatibilidade: 55/100 · confiança baixa

💡 O trabalho
Criar uma landing page adaptada ao celular, com estética cinematográfica e links para o checkout.

⚠️ Antes de assumir
Validar sua capacidade de entregar responsividade e desempenho com orientação e IA. Confirmar hospedagem e materiais.

🔒 Disponibilidade
Restrita na última consulta. Liberação estimada: 21/09 às 16h37, horário de Brasília. Confirmar no site.

🔗 Abrir oportunidade

Este exemplo usa dados históricos, não informação atual. Renderize os valores realmente persistidos. Não fixe preço, prazo, status, data ou resumo do exemplo no código.

### Regras de apresentação

- Diferencie orçamento informado pelo cliente de preço sugerido pela IA. Valor ausente é “não informado”.
- Compatibilidade é aderência, não chance de contratação ou sucesso. Explique isso uma vez nos detalhes, sem repetir em cada campo.
- Apresente verificação de competência separadamente de restrição premium. Nunca confirme competência por interesse, alias ou uso de IA.
- Remova do texto de produto nomes como basic-v2, hashes, versões, regras internas e explicações longas sobre notificações anteriores. Uma atualização pode ter o rótulo curto “Análise atualizada”.
- Agrupe ressalvas repetidas sem apagar informações distintas. Não acrescente afirmações por conta própria. Formatação não deve chamar IA para resumir ou traduzir.
- Traduza rótulos e mensagens internas determinísticas. Preserve texto já gerado e salvo quando não houver tradução segura; respostas futuras devem ser solicitadas em pt-BR, sem reanalisar todo o banco só por idioma.
- Resumo: mantenha aproximadamente 1.200 caracteres ou menos quando possível. Texto longo deve continuar nos detalhes, sem sumir.
- Detalhes: justificativa, competências e lacunas, riscos, premissas de esforço/preço, perguntas ao cliente e proposta integral. Diferencie “não verificada” de “ausente no perfil”.
- Separe claramente a proposta da análise interna e indique “Rascunho: revisar antes de enviar”. Não produza proposta para preencher espaço quando não existir rascunho válido.
- Use os recursos HTML já suportados pelo notificador, com escape correto. Link ou botão URL para a oportunidade; sem implementar callbacks ou candidatura.
- Nenhuma parte pode ultrapassar 4.096 caracteres após parsing. Divida em limites seguros, com título/ID e numeração. Não corte tags, emojis, frases arbitrariamente nem descarte o restante com reticências.
- Apenas o resumo pode gerar som; continuações usam envio silencioso. Desative prévias de links que atrapalhem a leitura.

### Entrega em partes e deduplicação

- Persista o conteúdo e o estado das partes de cada entrega. Confirme cada parte somente após sucesso do Telegram, guardando message_id quando disponível.
- Se resumo foi confirmado e detalhes falharam, a próxima execução retoma as partes faltantes. Reiniciar o processo não deve reenviar partes já confirmadas.
- Marque a entrega completa somente depois de todas as partes confirmadas. Preserve os registros antigos de notified_at.
- Mudança de apresentação não invalida análise nem dispara reenvio de todo o histórico.
- Documente a limitação de confirmação ambígua: timeout após possível envio não permite prometer exactly-once. Não faça repetição imediata cega nesse caso.

## 3. Descoberta e detalhes: fila no SQLite

Hoje os itens adiados podem desaparecer do alcance das páginas antes de serem processados. Corrija isso salvando o resumo descoberto antes de consultar o detalhe.

- Chave única por sourceId + externalId. Guarde URL canônica, resumo disponível, primeira/última descoberta, estado e tentativas necessárias para retomar.
- Inserção idempotente: um resumo redescoberto não zera trabalho concluído nem notificações.
- Distingua resumo conhecido de detalhe já obtido. Conhecer o ID não pode fazer o pipeline ignorar um detalhe pendente.
- Ao reiniciar, a fila deve continuar mesmo se a oportunidade já saiu das páginas consultadas.
- Marque detalhe concluído somente após persistir Opportunity com sucesso. Erros temporários preservam o trabalho; indisponibilidade permanente comprovada ganha estado e motivo próprios, sem retries eternos.
- Novas execuções começam pela primeira página para encontrar novidades. Continue com a paginação adaptativa existente, deduplicando sobreposições.
- Salve todos os resumos válidos das páginas já baixadas, mesmo que a última página ultrapasse um pouco a meta.
- Limites iniciais desejados: até 100 resumos novos por execução, até 20 páginas e até 20 detalhes. São limites independentes; não prometem varrer o site inteiro. Pare antes se a fonte acabar ou bloquear.
- Reutilize nomes de configuração existentes quando a semântica continuar correta; explique qualquer mudança de significado. Atualize .env.example. Pode atualizar no .env local somente as configurações não secretas desta SPEC, preservando os segredos sem exibi-los.
- Distribua o orçamento de detalhes entre novos e antigos pendentes, com regra simples e explícita, para que a fila antiga também avance.
- Preserve pausas da fonte e tratamento de 403, 429 e desafios. Não implemente login, contorno de captcha ou requisições paralelas agressivas.

## 4. IA: priorizar sem desperdiçar chamadas

- Mantenha gemini-3.6-flash, um provedor e ausência de fallback automático.
- Mantenha até 20 oportunidades por rodada, mas aplique também orçamento de requisições. Retry é outra requisição, não outra oportunidade.
- Priorize shortlist e review do filtro básico com sinais relevantes, considerando recência e tempo na fila. Não exclua uma vaga só por categoria conflitante, acesso premium ou competência não verificada.
- Itens basic-skip ficam guardados e fora da análise automática por padrão. A seleção explícita por ID pode permitir revisar um descarte, respeitando status e cota. Não confunda filtro básico skip com conclusão skip da IA.
- Um erro na proposta não deve provocar reanálise ilimitada da mesma vaga. Mantenha tentativas limitadas e falha visível; o próximo lote não pode ser monopolizado pelas mesmas rejeições.
- Normalize aliases conhecidos, inicialmente design responsivo / layouts responsivos / responsive layouts, preservando o nível unverified. Não faça alterações amplas no perfil.
- Não invalide automaticamente todos os sucessos por ajuste visual, fila ou transporte. Mudanças semânticas reais precisam da versão apropriada e explicação do impacto.

## 5. Cota Gemini: controles concretos

O print do projeto mostrou 5 RPM, 250 mil TPM e 20 RPD para o 3.6. Esses são os limites observados dessa conta, não uma promessa universal. O período de 28 dias mostra picos, não saldo atual.

- Intervalo mínimo configurável de 15 segundos entre inícios de todas as requisições, incluindo retries. Preserve o retry único para erros transitórios.
- Persista contador local de requisições por modelo e dia da cota. Padrão: no máximo 20 tentativas/dia; reserve a tentativa antes da chamada. O contador representa consumo observado pelo app, não saldo oficial do Google.
- A virada diária usa America/Los_Angeles, incluindo horário de verão. Não fixe offset nem use meia-noite de Brasília.
- Não invente contagem histórica exata. Se ainda não existe histórico suficiente, informe que o controle local começou nesta versão e pode não incluir consumo anterior ou externo.
- Impeça duas execuções simultâneas de ultrapassar limites: use um mecanismo simples de exclusão com recuperação de encerramento inesperado. Pausas e cooldowns devem sobreviver a reinício.
- Leia Retry-After e detalhes de quota quando presentes. Diferencie bloqueio por minuto, tokens, dia e causa desconhecida somente quando houver evidência.
- Em 429, encerre a etapa de IA e preserve a fila. Grave o cooldown aplicável; não retente continuamente, não altere modelo, não ative faturamento. Sem identificação da causa, reporte “limite não identificado”, sem inventar reset diário.
- Falha ou cota da IA não pode impedir o envio de análises já salvas. Mantenha coleta, análise e notificação acionáveis separadamente usando os comandos existentes ou extensões mínimas.
- Relatório: resumos novos, detalhes obtidos/pendentes, análises concluídas, rejeições, requisições/retries, motivo da parada e notificações/partes pendentes. Contagens não podem somar subconjuntos duas vezes.

## 6. Validação e entrega

Implemente em blocos: apresentação e entrega; fila; controle/prioridade de IA. Faça testes relevantes para os riscos abaixo, sem criar meta artificial de quantidade de testes:

- Resumo, detalhes e proposta completos com pt-BR, acentos, emojis, HTML e texto acima do limite.
- Falha na segunda parte: reinício retoma apenas partes faltantes; dry-run não envia nem marca entrega.
- Fila sobrevive a reinício e ao desaparecimento do item das listagens; páginas sobrepostas não duplicam registros; detalhe pendente não é ignorado por ID conhecido.
- Com IA limitada/bloqueada, coleta e envio de análises existentes continuam utilizáveis.
- Relógio simulado: 15 segundos entre chamadas/retries, limite diário persistido, virada America/Los_Angeles, reinício e exclusão concorrente. Não espere minutos reais em testes.
- Priorização, aliases e preservação do perfil unverified e das análises históricas.

Rode testes, typecheck e build ao concluir. Valide migrações em cópia antes do banco real.

Aceitação ao vivo autorizada e limitada:
1. Use a análise já salva de 99freelas:785772, sem chamar Gemini, para enviar UMA demonstração do novo formato ao Telegram do Don. Identifique como prévia visual, com dados da última consulta. Use uma entrega de demonstração separada, sem zerar flags de produção.
2. Repita a mesma entrega de demonstração e comprove zero novas partes confirmadas enviadas.
3. Uma descoberta real de no máximo 3 páginas e 2 detalhes para validar a fila. Testes offline comprovam o volume maior. Respeite os bloqueios da fonte.
4. Não consuma Gemini nesta aceitação. A integração já foi validada; esta SPEC testa formatação, armazenamento e controle de chamadas. Demonstre os novos controles com provedor simulado.

Atualize apenas README, STATUS, .env.example e CLAUDE.md quando necessário. No relatório final, mostre preview, evidências, migração, contagens, arquivos e git status; sem tabelas largas nem segredos.

Não faça commit da SPEC 005 antes da revisão. Não implemente dashboard, scheduler, segunda fonte, pagamento ou candidatura nesta missão. Próxima etapa planejada: dashboard local com oportunidades, análise completa e proposta para copiar.

## Referências oficiais

- Telegram, sendMessage e limite de texto: https://core.telegram.org/bots/api#sendmessage
- Gemini, dimensões de cota e virada diária: https://ai.google.dev/gemini-api/docs/rate-limits

Think wide, build small. A entrega precisa ser legível, retomar trabalho sem perder vagas e respeitar a cota observada.
