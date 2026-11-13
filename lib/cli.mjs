export function cliMessage(error) {
  if (error.code === '42P01' || error.code === '42883') {
    return 'O banco ainda não tem as tabelas. Execute npm run db:schema.';
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', '28P01', '3D000', '28000', '57P01'].includes(error.code)) {
    return 'Não foi possível conectar ao banco. Confira DATABASE_URL. A senha não deve ir para o código.';
  }
  return error.message || 'Falha inesperada.';
}
