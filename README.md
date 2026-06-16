# 🦏 ÁgilBank — Sistema de Empréstimos

O **ÁgilBank** é um sistema completo e intuitivo para gestão de empréstimos, focado em oferecer crédito rápido para pessoas com dificuldades de aprovação ("sem crédito na praça"). 

Desenvolvido como uma Single Page Application (SPA), o sistema permite cadastro simplificado, gestão de solicitações, cálculo automático de juros e controle completo de inadimplentes através de um painel administrativo.

## 🚀 Funcionalidades

### 👤 Portal do Cliente
- **Cadastro Simples:** Processo em 3 etapas sem verificação inicial de crédito nos birôs tradicionais.
- **Solicitação de Empréstimo:** O cliente define o valor, prazo e o motivo.
- **Acompanhamento:** Dashboard próprio com visão de empréstimos ativos, parcelas pagas, e saldo devedor.
- **Histórico e Pagamentos:** Visão detalhada de todas as parcelas de um empréstimo.

### 🔧 Painel do Administrador
- **Visão Geral Financeira:** Dashboards com valores totais emprestados, a receber, lucro obtido com juros e quantidade de clientes inadimplentes.
- **Análise de Solicitações:** O administrador pode aprovar as solicitações e **definir manualmente a taxa de juros** e o tipo de modalidade.
- **Cálculo Automático:**
  - **Convencional:** Calcula a parcela fixa diluindo o juro pelo tempo do empréstimo.
  - **Somente Juros:** O cliente paga o valor do juro mensalmente e o montante principal no final do contrato.
- **Gestão de Empréstimos:** Acompanhamento de atrasos, pagamentos e quitações manuais de parcelas.
- **Central de Avisos e SMS:** Envio rápido de mensagens SMS para cobrar devedores ou notificar sobre aprovações.

## 🛠 Tecnologias

O projeto é inteiramente baseado em tecnologias Web padrão, dispensando compilação complexa:
- **HTML5:** Estruturação semântica.
- **CSS3:** Design limpo, moderno (Dark Navy e Verde), totalmente responsivo.
- **JavaScript (Vanilla):** Lógica da aplicação, cálculos financeiros e manipulação da interface via DOM.
- **Armazenamento:** Utiliza `localStorage` para guardar os dados (simulando o banco de dados).

## 🚂 Instalação e Execução

### Execução Local
1. Clone este repositório:
   ```bash
   git clone https://github.com/SEU_USUARIO/agilbank.git
   ```
2. Abra a pasta do projeto.
3. Simplesmente abra o arquivo `index.html` em seu navegador, ou inicie um servidor local.

### 🌐 Hospedagem na Railway
O projeto já está adaptado para implantação automática na [Railway](https://railway.app).
Ele utiliza a biblioteca `serve` (configurada no `package.json`) para servir a aplicação como um site estático no Node.js.

**Passo a passo na Railway:**
1. Crie uma conta no [Railway](https://railway.app).
2. Clique em **"New Project"** > **"Deploy from GitHub repo"**.
3. Selecione este repositório (`agilbank`).
4. A Railway detectará automaticamente o `package.json`, instalará a biblioteca `serve` e fará o deploy.
5. Seu sistema estará no ar com a URL fornecida pela Railway!

## 🔐 Acessos de Demonstração

Para testar as funcionalidades do sistema, utilize as credenciais de teste configuradas (ou crie novos clientes no botão "Criar Conta").

| Tipo | Usuário / CPF | Senha |
|---|---|---|
| **Admin** | `admin` | `admin123` |
| **Cliente** | `123.456.789-00` | `123456` |

---
**Desenvolvido com foco em agilidade e segurança.** 🦏
